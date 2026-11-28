//! Mystic Realm: автозбор колб (реагентов) в ивентовом режиме.
//!
//! Модуль грузит `mystic/agent.js`, который ставит хук на пер-кадровый
//! `MysticRealmPlayState::update` и телепортирует колбы к герою — та же
//! механика, что у Candy в `catacombs` (запись stored x/y в тело и
//! destroy/rebuild). Раскладка памяти: `memory/offsets.js` → `MEMORY_LAYOUT.mystic`.
//!
//! Меню: `mystic` (включить), `mystic status`, `mystic off`.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use frida::{Message, Script, ScriptHandler, ScriptOption, Session};
use serde_json::Value;

pub const HELP: &str = r#"=== mystic — автозбор колб (Mystic Realm) ===

Собирает реагенты к герою: на каждом кадре обновления режима колба, ещё не
тронутая модулем, телепортируется к герою (запись stored x/y в тело +
destroy/rebuild), как это делает catacombs с Candy. Работает только внутри
забега Mystic Realm; в лобби хук просто ждёт.

  mystic              загрузить модуль и показать эту памятку
  mystic on           включить автозбор (хук уже стоит после `mystic`)
  mystic status       сколько колб переставлено и что было последним
  mystic timer <N>    подрезать оставшееся время забега до N секунд (например 3)
  mystic timer off    снять ограничение таймера
  mystic off          выгрузить модуль и снять хук (то же делает Ctrl+C в меню)

`mystic timer N` включает и сам автозбор: короткий забег без сбора смысла не
имеет. Если в `mystic status` видно `ХУК НЕ СТОИТ`, режим ничего не делает —
проверь, что жив `start.sh` (он держит frida-сервер), и перезагрузи модуль."#;

struct Handler;

impl ScriptHandler for Handler {
    fn on_message(&mut self, message: Message, _data: Option<Vec<u8>>) {
        match message {
            Message::Send(msg) => {
                let p = &msg.payload;
                match p.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "hooked" => eprintln!("INFO mystic: хук на update: {:?}", p.get("at")),
                    "error" => eprintln!("ERROR mystic: {:?}", p.get("msg")),
                    _ => {}
                }
            }
            Message::Error(e) => eprintln!("ERROR [mystic frida] {}", e.description),
            Message::Log(l) => eprintln!("[mystic {:?}] {}", l.level, l.payload),
            Message::Other(v) => eprintln!("ERROR [mystic frida] {v}"),
        }
    }
}

/// Одна строка состояния: сколько переставлено, сколько пропущено, что последним.
fn summary(value: &Value) -> String {
    summary_with(value, true)
}

/// То же, но с возможностью не ругаться на отсутствие хука (при выгрузке его и
/// не должно быть).
fn summary_with(value: &Value, expect_hook: bool) -> String {
    let num = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_u64())
            .map(|n| n.to_string())
            .unwrap_or_else(|| "?".to_string())
    };
    let enabled = value
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let last = value.get("last").cloned().unwrap_or(Value::Null);
    let last_text = match last.get("success").and_then(|v| v.as_bool()) {
        Some(true) => {
            let rarity = last
                .get("rarity")
                .and_then(|v| v.as_i64())
                .map(|r| r.to_string())
                .unwrap_or_else(|| "?".to_string());
            let matches = last
                .pointer("/check/matches")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            format!("ok (редкость {rarity}, проверка {matches})")
        }
        Some(false) => format!(
            "ошибка: {}",
            last.get("error").and_then(|v| v.as_str()).unwrap_or("?")
        ),
        None => "не было".to_string(),
    };
    let error = value.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let tail = if error.is_empty() {
        String::new()
    } else {
        format!(" error={error}")
    };
    let hooked = match value.get("hooked").and_then(|v| v.as_bool()) {
        Some(false) if expect_hook => " ХУК НЕ СТОИТ".to_string(),
        _ => String::new(),
    };
    let timer = match value.get("timer") {
        Some(t) => {
            let target = t
                .get("target")
                .and_then(|v| v.as_f64())
                .map(|v| format!("{v:.0}s"))
                .unwrap_or_else(|| "off".to_string());
            let left = t
                .get("left")
                .and_then(|v| v.as_f64())
                .map(|v| format!("{v:.1}s"))
                .unwrap_or_else(|| "?".to_string());
            format!(" timer={left}/{target}")
        }
        None => String::new(),
    };
    let timing = match value.get("timing") {
        Some(t) => format!(
            " tick={}/{}ms move={}ms",
            t.get("avg_ms").and_then(|v| v.as_u64()).unwrap_or(0),
            t.get("max_ms").and_then(|v| v.as_u64()).unwrap_or(0),
            t.get("move_max_ms").and_then(|v| v.as_u64()).unwrap_or(0)
        ),
        None => String::new(),
    };
    format!(
        "enabled={enabled} moved={} attempts={} skipped={} last={last_text}{tail}{hooked}{timer}{timing}",
        num("moved"),
        num("attempts"),
        num("skipped")
    )
}

pub struct MysticModule<'a> {
    session: &'a Session<'a>,
    root: PathBuf,
    script: Option<Script<'a>>,
}

impl<'a> MysticModule<'a> {
    pub fn new(session: &'a Session<'a>, root: PathBuf) -> Self {
        Self {
            session,
            root,
            script: None,
        }
    }

    /// Загружен ли модуль (агент с хуком).
    pub fn is_loaded(&self) -> bool {
        self.script.is_some()
    }

    /// `mystic` (загрузить + памятка), `mystic on`, `mystic status`, `mystic timer`, `mystic off`.
    pub fn run(
        &mut self,
        argument: &str,
        aborted: &AtomicBool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut words = argument.split_whitespace();
        let head = words.next().unwrap_or("").to_ascii_lowercase();
        match head.as_str() {
            "" => {
                // Как у catacombs: команда без аргументов грузит модуль и печатает памятку.
                self.ensure_loaded()?;
                println!("{HELP}");
                let value = self.call("status", None, aborted)?;
                println!("mystic: {}", summary(&value));
            }
            "on" => {
                self.ensure_loaded()?;
                let value = self.call("start", None, aborted)?;
                println!("mystic: {}", summary(&value));
            }
            "status" => {
                self.ensure_loaded()?;
                let value = self.call("status", None, aborted)?;
                println!("mystic: {}", summary(&value));
            }
            "timer" => {
                let value = words.next().unwrap_or("off");
                let seconds: f64 = if value.eq_ignore_ascii_case("off") {
                    0.0
                } else {
                    value
                        .parse()
                        .map_err(|_| format!("таймер: нужно число секунд или off, получено {value:?}"))?
                };
                if seconds < 0.0 {
                    return Err("таймер: секунды не могут быть отрицательными".into());
                }
                self.ensure_loaded()?;
                let reply = self.call("setTimer", Some(serde_json::json!([seconds])), aborted)?;
                println!("mystic: {}", summary(&reply));
            }
            "off" | "stop" => match self.unload() {
                Some(text) => println!("mystic: выключен ({text})"),
                None => println!("mystic: не был загружен"),
            },
            other => {
                return Err(format!("неизвестная подкоманда {other:?} (status/timer/off)").into());
            }
        }
        Ok(())
    }

    fn call(
        &mut self,
        name: &str,
        args: Option<Value>,
        aborted: &AtomicBool,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        let Some(script) = self.script.as_mut() else {
            return Ok(Value::Null);
        };
        Ok(script
            .exports
            .call_cancellable(name, args, Duration::from_secs(30), || {
                aborted.load(Ordering::SeqCst)
            })?
            .unwrap_or(Value::Null))
    }

    fn ensure_loaded(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if self.script.is_some() {
            return Ok(());
        }
        let path = self.root.join("mystic/agent.js");
        let source = crate::memory::prepend_layout(&path, &std::fs::read_to_string(&path)?)?;
        let mut options = ScriptOption::default();
        let mut script = self.session.create_script(&source, &mut options)?;
        script.handle_message(Handler)?;
        script.load()?;
        self.script = Some(script);
        Ok(())
    }

    /// Снять хук и выгрузить агент. Возвращает сводку, если модуль был загружен.
    pub fn unload(&mut self) -> Option<String> {
        let mut script = self.script.take()?;
        let value = script
            .exports
            .call("stop", None)
            .ok()
            .flatten()
            .unwrap_or(Value::Null);
        let _ = script.unload();
        Some(summary_with(&value, false))
    }

    pub fn stop(&mut self) {
        let _ = self.unload();
    }
}

impl Drop for MysticModule<'_> {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::{summary, HELP};

    #[test]
    fn summary_reports_moved_objects_and_last_result() {
        let value = serde_json::json!({
            "enabled": true,
            "moved": 4,
            "attempts": 5,
            "skipped": 1,
            "last": { "success": true, "rarity": 3, "check": { "matches": true } }
        });
        assert_eq!(
            summary(&value),
            "enabled=true moved=4 attempts=5 skipped=1 last=ok (редкость 3, проверка true)"
        );
    }

    #[test]
    fn summary_tolerates_empty_payload_and_reports_errors() {
        assert_eq!(
            summary(&serde_json::Value::Null),
            "enabled=false moved=? attempts=? skipped=? last=не было"
        );
        let value = serde_json::json!({
            "enabled": true,
            "moved": 0,
            "last": { "success": false, "error": "physics world заблокирован" },
            "error": "битый список объектов: -1"
        });
        assert_eq!(
            summary(&value),
            "enabled=true moved=0 attempts=? skipped=? last=ошибка: physics world заблокирован error=битый список объектов: -1"
        );
    }

    #[test]
    fn summary_shouts_when_the_hook_is_missing() {
        // Ровно этот случай ломал таймер: агент не смог поставить хук (на месте
        // пролога уже стоял трамплин), статус был бодрый, а режим ничего не делал.
        let value = serde_json::json!({
            "enabled": true,
            "hooked": false,
            "moved": 0,
            "timer": { "target": 3.0, "left": null }
        });
        let text = summary(&value);
        assert!(text.contains("ХУК НЕ СТОИТ"), "нет предупреждения: {text}");
        assert!(text.contains("timer=?/3s"), "нет таймера в статусе: {text}");
    }

    #[test]
    fn help_mentions_commands() {
        for cmd in ["mystic              загрузить", "mystic on", "mystic status", "mystic off"] {
            assert!(HELP.contains(cmd), "help не описывает {cmd}");
        }
    }
}
