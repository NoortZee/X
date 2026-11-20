//! Diagnostics and an explicit one-common-object position experiment.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use frida::{Message, Script, ScriptHandler, ScriptOption, Session};

struct Handler;
impl ScriptHandler for Handler {
    fn on_message(&mut self, message: Message, _data: Option<Vec<u8>>) {
        if let Message::Error(error) = message {
            eprintln!("ERROR catacombs JS: {error:?}");
        }
    }
}

pub struct CatacombsModule<'a> {
    session: &'a Session<'a>,
    root: PathBuf,
    script: Option<Script<'a>>,
}
impl<'a> CatacombsModule<'a> {
    pub fn new(session: &'a Session<'a>, root: PathBuf) -> Self {
        Self { session, root, script: None }
    }
    pub fn command(&mut self, command: &str, aborted: &AtomicBool) -> Result<(), Box<dyn std::error::Error>> {
        let (action, label) = command.split_once(' ').unwrap_or((command, ""));
        match action {
            "start" => {
                if self.script.is_some() {
                    println!("catacombs: already loaded; stop/start to reload profile");
                    return Ok(());
                }
                let path = self.root.join("catacombs/agent.js");
                let source = crate::memory::prepend_layout(&path, &std::fs::read_to_string(&path)?)?;
                let mut options = ScriptOption::default();
                let mut script = self.session.create_script(&source, &mut options)?;
                // The binding also needs this handler connection to deliver RPC replies.
                script.handle_message(Handler)?;
                script.load()?;
                println!("catacombs: resolving Endless update (Ctrl+C cancels waiting)...");
                match script.exports.call_cancellable("install", None, Duration::from_secs(30),
                    || aborted.load(Ordering::SeqCst)) {
                    Ok(value) => {
                        println!("catacombs: {value:?}");
                        self.script = Some(script);
                    }
                    Err(error) => { let _ = script.unload(); return Err(Box::new(error)); }
                }
            }
            "stop" => { self.stop(); println!("catacombs: stopped"); }
            "status" | "dump" | "mark" | "move-white" | "teleport-white" | "above" | "return-height" => {
                let Some(script) = self.script.as_mut() else {
                    println!("catacombs: start first"); return Ok(());
                };
                let method = match action { "dump" => "report", "move-white" => "moveWhite", "teleport-white" => "teleportWhite", "return-height" => "returnHeight", _ => action };
                let args = if action == "mark" { Some(serde_json::json!([label])) } else { None };
                let value = script.exports.call_cancellable(method, args, Duration::from_secs(5),
                    || aborted.load(Ordering::SeqCst))?;
                if action == "dump" {
                    let dir = self.root.join("logs/catacombs");
                    std::fs::create_dir_all(&dir)?;
                    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
                    let path = dir.join(format!("report-{stamp}.json"));
                    // create_new prevents any accidental overwrite, even on a clock collision.
                    use std::io::Write;
                    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
                    file.write_all(serde_json::to_string_pretty(&value)?.as_bytes())?;
                    println!("catacombs: {}", path.display());
                } else { println!("catacombs: {value:?}"); }
            }
            _ => println!("catacombs start | status | dump | mark <label> | move-white | teleport-white | above | return-height | stop"),
        }
        Ok(())
    }
    pub fn stop(&mut self) {
        if let Some(script) = self.script.take() { let _ = script.unload(); }
    }
}
impl Drop for CatacombsModule<'_> {
    fn drop(&mut self) { self.stop(); }
}
