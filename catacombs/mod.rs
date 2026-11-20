//! Opt-in, read-only diagnostic module; no reward or movement modifications.
use std::path::PathBuf;
use frida::{Script, ScriptOption, Session};

pub struct CatacombsModule<'a> {
    session: &'a Session<'a>,
    root: PathBuf,
    script: Option<Script<'a>>,
}

impl<'a> CatacombsModule<'a> {
    pub fn new(session: &'a Session<'a>, root: PathBuf) -> Self {
        Self { session, root, script: None }
    }

    pub fn command(&mut self, command: &str) -> Result<(), Box<dyn std::error::Error>> {
        match command {
            "start" => {
                if self.script.is_none() {
                    let path = self.root.join("catacombs/agent.js");
                    let source = std::fs::read_to_string(&path)?;
                    let source = crate::memory::prepend_layout(&path, &source)?;
                    let mut options = ScriptOption::default();
                    let mut script = self.session.create_script(&source, &mut options)?;
                    script.load()?;
                    match script.exports.call("install", None) {
                        Ok(status) => {
                            println!("catacombs: {status:?}");
                            self.script = Some(script);
                        }
                        Err(error) => {
                            let _ = script.unload();
                            return Err(Box::new(error));
                        }
                    }
                } else if let Some(script) = self.script.as_mut() {
                    println!("catacombs: {:?}", script.exports.call("install", None)?);
                }
            }
            "stop" => {
                self.stop();
                println!("catacombs: stopped");
            }
            "status" | "dump" => {
                if let Some(script) = self.script.as_mut() {
                    let value = script.exports.call(if command == "dump" { "report" } else { "status" }, None)?;
                    if command == "dump" {
                        let dir = self.root.join("logs");
                        std::fs::create_dir_all(&dir)?;
                        let path = dir.join("catacombs-report.json");
                        std::fs::write(&path, serde_json::to_string_pretty(&value)?)?;
                        println!("catacombs: {}", path.display());
                    } else {
                        println!("catacombs: {value:?}");
                    }
                } else {
                    println!("catacombs: stopped; use catacombs start");
                }
            }
            _ => println!("catacombs start | status | dump | stop — read-only diagnostics"),
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut script) = self.script.take() {
            let _ = script.exports.call("stop", None);
            let _ = script.unload();
        }
    }
}

impl Drop for CatacombsModule<'_> {
    fn drop(&mut self) { self.stop(); }
}
