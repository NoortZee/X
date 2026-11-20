use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use frida::{
    Device, DeviceManager, Frida, Message, Script, ScriptHandler, ScriptOption, Session,
};
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;

use crate::replay::ReplayEvent;

pub static FRIDA: LazyLock<Frida> = LazyLock::new(|| unsafe { Frida::obtain() });

#[derive(Error, Debug)]
pub enum AgentError {
    #[error("frida error: {0}")]
    Frida(#[from] frida::Error),
    #[error("game process not running ({0})")]
    ProcessNotFound(String),
    #[error("failed to read agent script {0}: {1}")]
    Io(String, std::io::Error),
    #[error("unexpected RPC response from {0}: {1}")]
    BadResponse(String, String),
}

const PRINT_TYPES: &[&str] = &[
    "event",
    "detect_started",
    "detect_stopped",
    "detect_installed",
    "pump_installed",
    "pump_already",
    "module_base",
    "fatal",
    "play_phase",
    "play_armed",
    "play_done",
    "gate_released",
    "jump_monitor_installed",
    "onframe_error",
    "dbg",
];

#[derive(Debug, Clone, Deserialize)]
pub struct JumpLogEntry {
    pub idx: u64,
    pub frame: i64,
    #[serde(default)]
    pub t: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlayState {
    pub phase: String,
    pub anchor: Option<i64>,
    pub frame: Option<i64>,
}

struct TasHandler {
    fatal: Arc<AtomicBool>,
}

impl ScriptHandler for TasHandler {
    fn on_message(&mut self, message: Message, _data: Option<Vec<u8>>) {
        match message {
            Message::Send(msg) => {
                let t = msg
                    .payload
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if PRINT_TYPES.contains(&t) {
                    println!("INFO agent: {}", msg.payload);
                }
                if t == "fatal" {
                    self.fatal.store(true, Ordering::SeqCst);
                }
            }
            Message::Log(log) => {
                eprintln!("[agent {:?}] {}", log.level, log.payload);
            }
            Message::Error(err) => {
                eprintln!(
                    "ERROR [frida] {} ({}:{}:{})",
                    err.description, err.file_name, err.line_number, err.column_number
                );
            }
            Message::Other(v) => {
                eprintln!("ERROR [frida] other: {v}");
            }
        }
    }
}

pub fn connect_remote_device<'a>(
    dm: &'a DeviceManager<'a>,
    remote_addr: &str,
) -> Result<Device<'a>, AgentError> {
    Ok(dm.get_remote_device(remote_addr)?)
}

pub fn attach_game_session<'a>(
    device: &'a Device<'a>,
    package: &str,
) -> Result<Session<'a>, AgentError> {
    let procs = device.enumerate_processes();
    let chosen = procs
        .iter()
        .find(|p| p.get_name() == package)
        .or_else(|| procs.iter().find(|p| p.get_name() == "King of Thieves"))
        .or_else(|| {
            procs
                .iter()
                .find(|p| p.get_name().to_ascii_lowercase().contains("thieves"))
        });

    let Some(proc) = chosen else {
        return Err(AgentError::ProcessNotFound(package.to_string()));
    };
    let pid = proc.get_pid();
    let name = proc.get_name().to_string();
    let session = device.attach(pid)?;
    eprintln!("INFO main: attached to {name} (pid={pid})");
    Ok(session)
}

pub struct TasAgent<'a> {
    script: Script<'a>,
    pump_installed: bool,
    pub fatal: Arc<AtomicBool>,
}

impl<'a> TasAgent<'a> {
    pub fn load(session: &'a Session<'a>, script_path: &std::path::Path) -> Result<Self, AgentError> {
        let src = std::fs::read_to_string(script_path)
            .map_err(|e| AgentError::Io(script_path.display().to_string(), e))?;

        let src = crate::memory::prepend_layout(script_path, &src)
            .map_err(|e| AgentError::Io(script_path.display().to_string(), e))?;

        let mut opts = ScriptOption::default();
        let mut script = session.create_script(&src, &mut opts)?;
        let fatal = Arc::new(AtomicBool::new(false));
        script.handle_message(TasHandler {
            fatal: fatal.clone(),
        })?;
        script.load()?;

        let mut me = Self {
            script,
            pump_installed: false,
            fatal,
        };
        me.rpc("detectInstall", None)?;
        Ok(me)
    }

    pub fn rpc(&mut self, name: &str, args: Option<Value>) -> Result<Value, AgentError> {
        let res = self.script.exports.call(name, args)?;
        Ok(res.unwrap_or(Value::Null))
    }

    pub fn ensure_pump(&mut self) -> Result<(), AgentError> {
        if self.pump_installed {
            return Ok(());
        }
        self.rpc("pumpInstall", None)?;
        self.pump_installed = true;
        eprintln!("INFO main: pump installed (lazy)");
        Ok(())
    }

    pub fn detect_start(&mut self) -> Result<(), AgentError> {
        self.rpc("detectStart", None)?;
        Ok(())
    }

    pub fn detect_stop(&mut self) -> Result<Vec<ReplayEvent>, AgentError> {
        let v = self.rpc("detectStop", None)?;
        serde_json::from_value(v)
            .map_err(|e| AgentError::BadResponse("detectStop".into(), e.to_string()))
    }

    pub fn detect_get_body_frames(&mut self) -> Result<Vec<Value>, AgentError> {
        let v = self.rpc("detectGetBodyFrames", None)?;
        serde_json::from_value(v)
            .map_err(|e| AgentError::BadResponse("detectGetBodyFrames".into(), e.to_string()))
    }

    pub fn detect_get_frame_ns_timeline(&mut self) -> Result<Vec<Value>, AgentError> {
        let v = self.rpc("detectGetFrameNsTimeline", None)?;
        serde_json::from_value(v).map_err(|e| {
            AgentError::BadResponse("detectGetFrameNsTimeline".into(), e.to_string())
        })
    }

    pub fn detect_get_rng_log(&mut self) -> Result<Option<Vec<Value>>, AgentError> {
        let v = self.rpc("detectGetRngLog", None)?;
        let list: Vec<Value> = serde_json::from_value(v)
            .map_err(|e| AgentError::BadResponse("detectGetRngLog".into(), e.to_string()))?;
        if list.is_empty() {
            Ok(None)
        } else {
            Ok(Some(list))
        }
    }

    pub fn pump_jump_count(&mut self) -> Result<u64, AgentError> {
        let v = self.rpc("pumpJumpCount", None)?;
        v.as_u64()
            .ok_or_else(|| AgentError::BadResponse("pumpJumpCount".into(), v.to_string()))
    }

    pub fn pump_jump_log_since(&mut self, idx: u64) -> Result<Vec<JumpLogEntry>, AgentError> {
        let v = self.rpc("pumpJumpLogSince", Some(json!([idx])))?;
        serde_json::from_value(v)
            .map_err(|e| AgentError::BadResponse("pumpJumpLogSince".into(), e.to_string()))
    }

    pub fn ring_tail(&mut self, n: usize) -> Result<Vec<Value>, AgentError> {
        let v = self.rpc("ringTail", Some(json!([n])))?;
        serde_json::from_value(v)
            .map_err(|e| AgentError::BadResponse("ringTail".into(), e.to_string()))
    }

    pub fn play_setup(
        &mut self,
        events: &[ReplayEvent],
        body_frames: &[Value],
        verify_body: bool,
    ) -> Result<Value, AgentError> {
        let opts = if verify_body {
            json!({ "verify_body": true, "body_frames": body_frames })
        } else {
            json!({ "verify_body": false })
        };
        self.rpc("playSetup", Some(json!([events, opts])))
    }

    pub fn play_state(&mut self) -> Result<PlayState, AgentError> {
        let v = self.rpc("playState", None)?;
        serde_json::from_value(v)
            .map_err(|e| AgentError::BadResponse("playState".into(), e.to_string()))
    }

    pub fn play_verify(&mut self) -> Result<Value, AgentError> {
        self.rpc("playVerify", None)
    }

    pub fn play_stop(&mut self) -> Result<(), AgentError> {
        self.rpc("playStop", None)?;
        Ok(())
    }
}

impl Drop for TasAgent<'_> {
    fn drop(&mut self) {
        let _ = self.script.unload();
    }
}
