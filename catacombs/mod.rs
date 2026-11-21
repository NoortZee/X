//! Catacombs module: load on command; inside, only the character speed is configurable.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use frida::{Message, Script, ScriptHandler, ScriptOption, Session};

struct Handler;
impl ScriptHandler for Handler {
    fn on_message(&mut self, message: Message, _data: Option<Vec<u8>>) {
        if let Message::Error(error) = message {
            eprintln!("ERROR catacombs JS: {error:?}");
        }
    }
}

fn summary(value: &serde_json::Value, requested: Option<u32>) -> String {
    let get = |path: &[&str]| path.iter().try_fold(value, |acc, key| acc.get(*key)).cloned().unwrap_or(serde_json::Value::Null);
    let speed = get(&["speed"]);
    let reported = speed.get("requested").and_then(|v| v.as_u64()).or(requested.map(u64::from));
    let speed_text = match (reported, speed.get("status").and_then(|v| v.as_str())) {
        (Some(n), Some(s)) => format!("speed={n} ({s})"),
        (Some(n), None) => format!("speed={n}"),
        _ => "speed=?".to_string(),
    };
    let enabled = get(&["enabled"]).as_bool().unwrap_or(false);
    let phase = get(&["latest", "phase_raw"]);
    format!("{speed_text} enabled={enabled} phase={phase}")
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
    /// The command is the module name with an optional speed: `catacombs`, `catacombs 5`.
    pub fn run(&mut self, argument: &str, aborted: &AtomicBool) -> Result<(), Box<dyn std::error::Error>> {
        let argument = argument.trim();
        {
            if argument.eq_ignore_ascii_case("stop") {
                match self.unload() { Some(s) => println!("catacombs: stopped ({s})"),
                    None => println!("catacombs: not loaded") }
                return Ok(());
            }
            let mut words = argument.split_whitespace();
            let speed_text = words.next().unwrap_or("");
            if words.next().is_some() || (!speed_text.is_empty() && !speed_text.chars().all(|c| c.is_ascii_digit())) {
                return Err(format!("only a speed 1..10 is accepted, got {argument:?}").into());
            }
            let speed: u32 = if speed_text.is_empty() { 1 }
                else { speed_text.parse().map_err(|_| format!("speed must be an integer 1..10, got {speed_text:?}"))? };
            if !(1..=10).contains(&speed) { return Err(format!("speed must be 1..10, got {speed}").into()); }
            self.ensure_loaded()?;
            let Some(script) = self.script.as_mut() else {
                println!("catacombs: not loaded"); return Ok(());
            };
            let value: serde_json::Value = script.exports
                .call_cancellable("start", Some(serde_json::json!([speed])),
                    Duration::from_secs(30), || aborted.load(Ordering::SeqCst))?
                .unwrap_or(serde_json::Value::Null);
            println!("catacombs: {}", summary(&value, Some(speed)));
        }
        Ok(())
    }
    fn ensure_loaded(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if self.script.is_some() { return Ok(()); }
        let path = self.root.join("catacombs/agent.js");
        let source = crate::memory::prepend_layout(&path, &std::fs::read_to_string(&path)?)?;
        let mut options = ScriptOption::default();
        let mut script = self.session.create_script(&source, &mut options)?;
        // The binding also needs this handler connection to deliver RPC replies.
        script.handle_message(Handler)?;
        script.load()?;
        self.script = Some(script);
        Ok(())
    }
    /// Restore what the agent patched, then drop the script.
    /// Returns a one-line summary when a module was actually loaded.
    pub fn unload(&mut self) -> Option<String> {
        let mut script = self.script.take()?;
        // Unloading alone would leave the speed patch applied: ask the agent to restore first.
        let value = script.exports.call("stop", None).ok().flatten()
            .unwrap_or(serde_json::Value::Null);
        let _ = script.unload();
        Some(summary(&value, None))
    }
    pub fn stop(&mut self) {
        let _ = self.unload();
    }
}
impl Drop for CatacombsModule<'_> {
    fn drop(&mut self) { self.stop(); }
}

#[cfg(test)]
mod tests {
    use super::summary;

    #[test]
    fn summary_reports_requested_speed_and_phase() {
        let value = serde_json::json!({"enabled": true, "speed": {"requested": 5, "status": "applied"},
            "latest": {"phase_raw": 1}});
        assert_eq!(summary(&value, None), "speed=5 (applied) enabled=true phase=1");
    }

    #[test]
    fn summary_falls_back_to_the_requested_value_and_tolerates_missing_payload() {
        // A null RPC reply must not panic, and the requested speed is still shown.
        assert_eq!(summary(&serde_json::Value::Null, Some(7)),
            "speed=7 enabled=false phase=null");
    }
}
