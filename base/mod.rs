//! Модуль «save base» (server logic).
//!
//! Перехватывает исходящую дельту редактора (`ChangeDungeonObject`, поле 30
//! обёртки `KTProtocol::Request`) и сдвигает координаты перемещаемого объекта
//! на заданное число клеток или пикселей — на сервер уходят одни числа, а
//! клиент продолжает показывать свои.
//!
//! Важно: дельта пишется в ЧЕРНОВИК базы. Другие игроки видят только
//! зафиксированное состояние, то есть после успешного `ConfirmDungeon`
//! (сервер проверяет, что ваш реплей проходит в новой раскладке).
//!
//! Меню: `base …` (см. [`HELP`]). Настройки: `config.yaml` → `base:`.
//! Раскладка памяти и AOB-сигнатуры: `memory/offsets.js` → `MEMORY_LAYOUT.protocol`.

use std::path::{Path, PathBuf};

use frida::{Message, Script, ScriptHandler, ScriptOption, Session};
use serde_json::{json, Value};
use thiserror::Error;

pub mod config;

use self::config::{BaseConfig, Direction};

pub const HELP: &str = r#"=== base — сохранение базы (серверная логика) ===

Модуль подменяет координаты в исходящей дельте редактора
(ChangeDungeonObject): клиент показывает одно, сервер получает другое.
Клетка арены = 64 px (x 0..896, y 0..448).

  base                     эта справка / состояние модуля
  base cells <N> <dir>     сдвиг на N клеток: left | right | up | down
  base px <dx> <dy>        сдвиг в пикселях (например: base px -32 0)
  base on                  включить подмену с текущим смещением
  base off                 выключить (дельты уходят как есть)
  base reset [x y]         все объекты базы в одну точку (по умолчанию 448 224)
  base reset off           снять режим reset
  base status              что сейчас применяется
  base stop                снять хуки

Примеры:
  base cells 1 left        сдвинуть перемещённую ловушку на клетку влево
  base px 32 0             на 32 px вправо
  base off                 вернуть штатное поведение
  base reset               собрать всю базу в центр арены
  base reset 64 64         собрать в левый верхний угол

RESET — только для меня: координаты объектов правятся в памяти клиента в
момент разбора макета (сообщение Dungeon), на сервер не уходит ничего, и
черновик базы на сервере остаётся прежним. Режим держится до `base reset off`:
каждый новый разбор раскладки снова собирает объекты в точку, поэтому после
команды нужно зайти в редактор базы заново (или перезапустить игру — kot-tas
переподключится и восстановит режим). Клиент вправе разложить объекты по
соседним клеткам, чтобы они не перекрывались, — тогда это плотная группа у
точки, а не идеальная стопка.

ОГРАНИЧЕНИЕ: дельта идёт в черновик базы. Игроки, которые заходят на базу,
получают её только после успешного подтверждения забега (`ConfirmDungeon`),
поэтому сдвиг объекта на вашем маршруте ломает подтверждение (реплей
расходится).
"#;

/// Точка по умолчанию для `base reset` — центр арены (896×448).
pub const RESET_DEFAULT: (i64, i64) = (448, 224);

#[derive(Error, Debug)]
pub enum BaseError {
    #[error("frida error: {0}")]
    Frida(#[from] frida::Error),
    #[error("hook.js not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Usage(String),
}

// ------------------------------------------------------------
// Frida handler
// ------------------------------------------------------------
/// Значение из сообщения агента как текст: без `Some(Number(...))` в консоли.
fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "—".to_string(),
    }
}

struct BaseHandler;

impl ScriptHandler for BaseHandler {
    fn on_message(&mut self, message: Message, _data: Option<Vec<u8>>) {
        match message {
            Message::Send(msg) => {
                let p = &msg.payload;
                let t = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match t {
                    "module_ready" => eprintln!(
                        "INFO base: hook.js загружен, module_base={:?}",
                        p.get("base")
                    ),
                    "aob" => eprintln!(
                        "INFO base: {} at {:?} offset={:?}",
                        p.get("fn").and_then(|v| v.as_str()).unwrap_or("?"),
                        p.get("at"),
                        p.get("offset")
                    ),
                    "hooked" => eprintln!("INFO base: хук установлен на {:?}", p.get("at")),
                    "level_loaded" => eprintln!(
                        "INFO base: уровень собран ({}): seed={} layout={} ловушек={}",
                        p.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
                        value_text(p.get("seed")),
                        value_text(p.get("layout")),
                        value_text(p.get("traps"))
                    ),
                    "level_left" => eprintln!(
                        "INFO base: с уровня ушли ({:?}) — база больше не считается текущей",
                        p.get("reason")
                    ),
                    "patched" => {
                        println!(
                            "[base] #{} слот={} x {} -> {}  y {} -> {}  (offset {}/{})",
                            p.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
                            p.pointer("/before/slot").and_then(|v| v.as_i64()).unwrap_or(-1),
                            p.pointer("/before/x").and_then(|v| v.as_i64()).unwrap_or(-1),
                            p.pointer("/after/x").and_then(|v| v.as_i64()).unwrap_or(-1),
                            p.pointer("/before/y").and_then(|v| v.as_i64()).unwrap_or(-1),
                            p.pointer("/after/y").and_then(|v| v.as_i64()).unwrap_or(-1),
                            p.pointer("/offset/x").and_then(|v| v.as_i64()).unwrap_or(0),
                            p.pointer("/offset/y").and_then(|v| v.as_i64()).unwrap_or(0),
                        );
                    }
                    "reset" => println!(
                        "[base] reset: {} объектов -> ({}, {}) [{:?}] всего {}",
                        p.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
                        p.get("x").and_then(|v| v.as_i64()).unwrap_or(0),
                        p.get("y").and_then(|v| v.as_i64()).unwrap_or(0),
                        p.get("where").and_then(|v| v.as_str()).unwrap_or("?"),
                        p.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                    ),
                    "err" => eprintln!(
                        "ERROR base: where={:?} msg={:?}",
                        p.get("where"),
                        p.get("msg")
                    ),
                    _ => {}
                }
            }
            Message::Error(e) => eprintln!("ERROR [base frida] {}", e.description),
            Message::Log(l) => eprintln!("[base {:?}] {}", l.level, l.payload),
            Message::Other(v) => eprintln!("ERROR [base frida] {v}"),
        }
    }
}

// ------------------------------------------------------------
// Source loading (как в stones: чистим BOM/CRLF/невидимые символы)
// ------------------------------------------------------------
const BAD_CHARS: &[char] = &[
    '\u{0085}', '\u{200B}', '\u{200C}', '\u{200D}', '\u{200E}', '\u{200F}', '\u{2060}', '\u{2061}',
    '\u{2062}', '\u{2063}', '\u{2064}', '\u{FEFF}',
];

fn load_hook_source(path: &Path) -> Result<String, BaseError> {
    if !path.exists() {
        return Err(BaseError::NotFound(path.display().to_string()));
    }
    let bytes = std::fs::read(path)?;
    let slice = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let mut src = String::from_utf8_lossy(slice).into_owned();
    src = src
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{2028}', '\u{2029}'], "\n");
    src.retain(|c| !BAD_CHARS.contains(&c));
    Ok(crate::memory::prepend_layout(path, &src)?)
}

// ------------------------------------------------------------
// Module
// ------------------------------------------------------------
pub struct BaseModule<'a> {
    session: &'a Session<'a>,
    hook_path: PathBuf,
    script: Option<Script<'a>>,
    cell_px: i64,
    offset: (i64, i64),
    enabled: bool,
    reset: Option<(i64, i64)>,
}

/// Состояние модуля, которое надо восстановить после переподключения к игре:
/// перезапуск игры рвёт frida-сессию, хуки и режим reset ставятся заново.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseSnapshot {
    pub offset: (i64, i64),
    pub enabled: bool,
    pub reset: Option<(i64, i64)>,
}

impl BaseSnapshot {
    pub fn from_config(cfg: &BaseConfig) -> Self {
        let offset = cfg.resolve();
        Self {
            offset,
            enabled: cfg.enabled && offset != (0, 0),
            reset: None,
        }
    }
}

impl<'a> BaseModule<'a> {
    pub fn new(session: &'a Session<'a>, hook_path: PathBuf, cfg: &BaseConfig) -> Self {
        let (dx, dy) = cfg.resolve();
        Self {
            session,
            hook_path,
            script: None,
            cell_px: cfg.cell_px.max(1),
            offset: (dx, dy),
            enabled: cfg.enabled && (dx != 0 || dy != 0),
            reset: None,
        }
    }

    pub fn ensure_loaded(&mut self) -> Result<(), BaseError> {
        if self.script.is_some() {
            return Ok(());
        }
        let src = load_hook_source(&self.hook_path)?;
        let mut opts = ScriptOption::default();
        let mut script = self.session.create_script(&src, &mut opts)?;
        script.handle_message(BaseHandler)?;
        script.load()?;
        let base = script.exports.call("moduleBase", None)?;
        eprintln!("INFO base: module_base={base:?}");
        script.exports.call("installHooks", None)?;
        // применяем смещение из конфига
        let (dx, dy) = self.offset;
        let _ = script
            .exports
            .call("setPixels", Some(json!([dx, dy])))?;
        let _ = script
            .exports
            .call("enable", Some(json!([self.enabled])))?;
        if let Some((x, y)) = self.reset {
            let _ = script.exports.call("reset", Some(json!([x, y])))?;
        }
        self.script = Some(script);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut s) = self.script.take() {
            let _ = s.exports.call("unhookAll", None);
            let _ = s.unload();
            eprintln!("INFO base: хуки сняты");
        }
    }

    fn rpc(&mut self, name: &str, args: Option<Value>) -> Result<Value, BaseError> {
        self.ensure_loaded()?;
        let s = self.script.as_mut().unwrap();
        Ok(s.exports.call(name, args)?.unwrap_or(Value::Null))
    }

    /// Сдвиг на N клеток в заданном направлении.
    pub fn set_cells(&mut self, cells: i64, dir: Direction) -> Result<Value, BaseError> {
        let (dx, dy) = dir.offset_px(cells, self.cell_px);
        self.offset = (dx, dy);
        self.enabled = dx != 0 || dy != 0;
        self.rpc("setCells", Some(json!([cells, dir.label()])))
    }

    /// Сдвиг в пикселях.
    pub fn set_pixels(&mut self, dx: i64, dy: i64) -> Result<Value, BaseError> {
        self.offset = (dx, dy);
        self.enabled = dx != 0 || dy != 0;
        self.rpc("setPixels", Some(json!([dx, dy])))
    }

    /// Все объекты макета — в одну точку (только в памяти клиента).
    pub fn reset(&mut self, x: i64, y: i64) -> Result<Value, BaseError> {
        self.reset = Some((x, y));
        self.rpc("reset", Some(json!([x, y])))
    }

    /// Снять режим reset.
    pub fn reset_off(&mut self) -> Result<Value, BaseError> {
        self.reset = None;
        self.rpc("resetOff", None)
    }

    /// Раскладка последнего разобранного Dungeon: seed (id базы), подпись и
    /// ловушки. Устанавливает хуки, если они ещё не стоят — только чтение.
    pub fn dungeon_snapshot(&mut self) -> Result<Value, BaseError> {
        self.rpc("dungeonSnapshot", None)
    }

    /// Что нужно восстановить после переподключения к игре.
    pub fn snapshot(&self) -> BaseSnapshot {
        BaseSnapshot {
            offset: self.offset,
            enabled: self.enabled,
            reset: self.reset,
        }
    }

    /// Восстановить состояние прошлой сессии (до загрузки хука).
    pub fn restore(&mut self, snapshot: &BaseSnapshot) {
        self.offset = snapshot.offset;
        self.enabled = snapshot.enabled;
        self.reset = snapshot.reset;
    }

    pub fn enable(&mut self, on: bool) -> Result<Value, BaseError> {
        self.enabled = on;
        self.rpc("enable", Some(json!([on])))
    }

    pub fn status(&mut self) -> Result<Value, BaseError> {
        let agent = self.rpc("status", None)?;
        Ok(json!({
            "host": {
                "enabled": self.enabled,
                "offset": { "x": self.offset.0, "y": self.offset.1 },
                "cell_px": self.cell_px,
            },
            "agent": agent,
        }))
    }
}

// ------------------------------------------------------------
// Menu commands
// ------------------------------------------------------------
fn parse_i64(s: &str) -> Result<i64, BaseError> {
    s.trim()
        .parse::<i64>()
        .map_err(|_| BaseError::Usage(format!("не число: {s:?}")))
}

/// Обработка аргументов после `base` (без самого слова).
pub fn handle(module: &mut BaseModule<'_>, argv: &[&str]) -> Result<(), BaseError> {
    if argv.is_empty() {
        println!("{HELP}");
        println!("state: {}", module.status()?);
        return Ok(());
    }
    match argv[0].to_ascii_lowercase().as_str() {
        "cells" => {
            let n = argv
                .get(1)
                .ok_or_else(|| BaseError::Usage("base cells <N> <dir>".into()))?;
            let dir_s = argv
                .get(2)
                .ok_or_else(|| BaseError::Usage("base cells <N> <dir>".into()))?;
            let cells = parse_i64(n)?;
            let dir = Direction::parse(dir_s)
                .ok_or_else(|| BaseError::Usage(format!("dir должен быть left/right/up/down: {dir_s:?}")))?;
            let r = module.set_cells(cells, dir)?;
            println!("base: {r}");
        }
        "px" | "pixels" => {
            let dx = parse_i64(
                argv.get(1)
                    .ok_or_else(|| BaseError::Usage("base px <dx> <dy>".into()))?,
            )?;
            let dy = parse_i64(
                argv.get(2)
                    .ok_or_else(|| BaseError::Usage("base px <dx> <dy>".into()))?,
            )?;
            let r = module.set_pixels(dx, dy)?;
            println!("base: {r}");
        }
        "reset" => {
            if argv.get(1).map(|s| s.eq_ignore_ascii_case("off")).unwrap_or(false) {
                println!("base: reset {}", module.reset_off()?);
            } else {
                let (x, y) = match (argv.get(1), argv.get(2)) {
                    (None, None) => RESET_DEFAULT,
                    (Some(x), Some(y)) => (parse_i64(x)?, parse_i64(y)?),
                    _ => {
                        return Err(BaseError::Usage(
                            "base reset [<x> <y> | off]".into(),
                        ))
                    }
                };
                println!("base: reset {}", module.reset(x, y)?);
            }
        }
        "on" => {
            let r = module.enable(true)?;
            println!("base: enabled={r}");
        }
        "off" => {
            let r = module.enable(false)?;
            println!("base: enabled={r}");
        }
        "status" => println!("base: {}", module.status()?),
        "stop" => {
            module.stop();
            println!("base: stopped");
        }
        other => {
            return Err(BaseError::Usage(format!(
                "неизвестная подкоманда {other:?} (cells/px/on/off/reset/status/stop)"
            )))
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Пустая сессия недоступна без устройства, поэтому проверяем только то,
    // что не требует frida: разбор аргументов и наличие исходника хука.
    #[test]
    fn hook_source_exists_and_prepends_layout() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let src = load_hook_source(&root.join("base").join("hook.js")).unwrap();
        assert!(src.contains("const MEMORY_LAYOUT ="));
        assert!(src.contains("SERIALIZE_TO_ARRAY"));
    }

    #[test]
    fn help_mentions_commands() {
        for cmd in ["base cells", "base px", "base off", "base reset", "base status"] {
            assert!(HELP.contains(cmd), "help не описывает {cmd}");
        }
    }
}
