//! Формат файла реплея: Markdown-контейнер, один файл на прогон.
//!
//! Правило разбора: читаем только содержимое fenced-блоков с известным
//! info-string (`yaml`, `frames`, `state`); всё остальное — заголовки, ссылка
//! на скриншот, base64, пояснения — игнорируется. Поиск по всему файлу
//! (как было с JSON-числами) запрещён: именно он превращал таймлайн в прыжки.
//!
//! Единственный источник истины для прыжков — блок `state` (полные значения
//! персонажа на момент прыжка). Блок `frames` — резерв для ручной правки и
//! для файлов без `state`. Если есть оба и прыжки в них не совпадают, файл
//! считается противоречивым и не загружается: молча выбрать один — это то,
//! из-за чего прежний формат путал шапку и тело.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Версия схемы файла. Несовпадение — отказ с явной ошибкой, без «догадок».
pub const SCHEMA: u32 = 1;

#[derive(Error, Debug)]
pub enum ReplayIoError {
    #[error("failed to write replay: {0}")]
    Io(#[from] std::io::Error),
    #[error("replay {path}: {reason}")]
    Format { path: String, reason: String },
}

impl ReplayIoError {
    fn at(path: &Path, reason: impl Into<String>) -> Self {
        Self::Format {
            path: path.display().to_string(),
            reason: reason.into(),
        }
    }
}

/// Событие прогона, которое читает плеер: кадр и роль (`first_hero_update`, `jump`).
/// Остальные поля сообщения агента намеренно игнорируются.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayEvent {
    pub frame: i64,
    pub name: String,
}

/// Ловушка базы в том виде, в котором её отдаёт сервер (`Dungeon.f1[]`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Trap {
    pub slot: i64,
    #[serde(rename = "type")]
    pub kind: i64,
    pub x: i64,
    pub y: i64,
}

/// Шапка реплея (`yaml`-блок).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub schema: u32,
    /// `Dungeon.f5` — скелет базы: сколько ловушек и какая арена.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<i64>,
    /// Подпись раскладки (FNV-1a 32 по `slot/type/x/y`), считается агентом.
    /// Хранится строкой в hex: сравнивается на равенство, арифметики не требует.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    #[serde(default = "default_fps")]
    pub fps: f64,
    #[serde(default = "default_tap")]
    pub tap_down_ms: u64,
    /// `kind@frame` — якорь, от которого считаются дельты прыжков.
    /// Номер варианта прохождения для пары (скелет, раскладка): 1, 2, 3…
    /// Один и тот же уровень можно пройти по-разному, и все прохождения нужны.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(default)]
    pub jumps: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// Имя PNG рядом с файлом (шапка файла — скриншот базы).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
}

fn default_fps() -> f64 {
    60.0
}

fn default_tap() -> u64 {
    1
}

impl Default for Meta {
    fn default() -> Self {
        Self {
            schema: SCHEMA,
            base: None,
            layout: None,
            fps: 60.0,
            tap_down_ms: 1,
            variant: None,
            anchor: None,
            jumps: 0,
            created: None,
            screenshot: None,
        }
    }
}

/// Реплей в памяти: шапка, раскладка, план и эталон состояния.
#[derive(Debug, Clone, Default)]
pub struct Replay {
    pub meta: Meta,
    pub traps: Vec<Trap>,
    pub anchor_frame: Option<i64>,
    pub anchor_kind: Option<String>,
    pub events: Vec<ReplayEvent>,
    /// Полные значения персонажа на момент прыжка (для сверки при `play`).
    pub body_frames: Vec<Value>,
    /// Был ли в файле блок `state` с данными. Если нет — `play` идёт по
    /// резервному плану `frames`: прыжки те же, а сверять состояние не с чем.
    pub has_state: bool,
    /// План в миллисекундах от старта уровня (`+400ms` в блоке `frames`).
    /// Такой план исполняется по стенным часам и НЕ пересчитывается в кадры.
    /// Одновременно с прыжками в кадрах не используется.
    pub ms_steps: Vec<i64>,
}

#[derive(Debug, Clone)]
pub struct PlanStep {
    pub idx: usize,
    pub rec_frame: i64,
    pub frame_delta: i64,
}

pub fn find_anchor(events: &[ReplayEvent], body_frames: &[Value]) -> Option<(String, i64)> {
    for e in events {
        if e.name == "first_hero_update" {
            return Some(("first_hero_update".into(), e.frame));
        }
    }
    if let Some(first) = body_frames.first() {
        if let Some(f) = first.get("frame").and_then(|v| v.as_i64()) {
            return Some(("first_body_frame".into(), f));
        }
    }
    for e in events {
        if e.name == "unfreeze" || e.name == "unfreeze_attack" {
            return Some(("unfreeze".into(), e.frame));
        }
    }
    None
}

pub fn build_plan(events: &[ReplayEvent], anchor_rec_frame: i64) -> Vec<PlanStep> {
    let mut jumps: Vec<&ReplayEvent> = events.iter().filter(|e| e.name == "jump").collect();
    jumps.sort_by_key(|e| e.frame);
    jumps
        .into_iter()
        .enumerate()
        .map(|(idx, j)| PlanStep {
            idx,
            rec_frame: j.frame,
            frame_delta: (j.frame - anchor_rec_frame).max(0),
        })
        .collect()
}

// ------------------------------------------------------------
// Запись: сборка md
// ------------------------------------------------------------
const STATE_FLOATS: [&str; 6] = ["px", "py", "ang", "vx", "vy", "av"];
const STATE_INTS: [&str; 4] = ["a0", "b0", "g80", "g84"];
const STATE_HEADER: &str = "# frame px py ang vx vy av a0 b0 g80 g84";

/// Дефолты для сжатия повторов в скрипт кадров (`+26 / +26 / +26` -> `loop 3`).
pub fn emit_delta_lines(deltas: &[i64]) -> Vec<String> {
    let n = deltas.len();
    let mut lines = Vec::new();
    let mut i = 0;
    while i < n {
        let max_plen = 6.min((n - i) / 2);
        let mut best_pat: Option<&[i64]> = None;
        let mut best_len = 0usize;
        let mut best_reps = 0usize;

        for plen in 1..=max_plen {
            let pat = &deltas[i..i + plen];
            let mut reps = 1usize;
            let mut j = i + plen;
            while j + plen <= n && &deltas[j..j + plen] == pat {
                reps += 1;
                j += plen;
            }
            if reps >= 2 && reps * plen > best_reps * best_len {
                best_pat = Some(pat);
                best_len = plen;
                best_reps = reps;
            }
        }

        if let (Some(pat), true) = (best_pat, best_reps >= 2) {
            lines.push(format!("loop {best_reps} {{"));
            for d in pat {
                lines.push(format!("+{d}"));
            }
            lines.push("}".into());
            i += best_reps * best_len;
        } else {
            lines.push(format!("+{}", deltas[i]));
            i += 1;
        }
    }
    lines
}

pub fn build_frame_script(events: &[ReplayEvent], anchor_frame: Option<i64>) -> String {
    let Some(anchor) = anchor_frame else {
        return String::new();
    };
    let mut jump_frames: Vec<i64> = events
        .iter()
        .filter(|e| e.name == "jump")
        .map(|e| e.frame)
        .collect();
    if jump_frames.is_empty() {
        return String::new();
    }
    jump_frames.sort_unstable();

    let mut deltas = Vec::with_capacity(jump_frames.len());
    let mut prev = anchor;
    for f in jump_frames {
        deltas.push(f - prev);
        prev = f;
    }
    emit_delta_lines(&deltas).join("\n")
}

/// Компактное представление float32: Display для f32 даёт кратчайшую запись,
/// которая читается обратно в то же значение — иначе сверка при `play` даст
/// ложные расхождения на битовом сравнении.
fn fmt_f32(v: f64) -> String {
    format!("{}", v as f32)
}

fn state_rows(body_frames: &[Value]) -> (Vec<String>, usize) {
    let mut rows = Vec::with_capacity(body_frames.len());
    let mut skipped = 0usize;
    let mut sorted: Vec<&Value> = body_frames.iter().collect();
    sorted.sort_by_key(|row| row.get("frame").and_then(|v| v.as_i64()).unwrap_or(i64::MAX));
    for row in sorted {
        let Some(frame) = row.get("frame").and_then(|v| v.as_i64()) else {
            skipped += 1;
            continue;
        };
        let mut parts = vec![frame.to_string()];
        let mut ok = true;
        for key in STATE_FLOATS {
            match row.get(key).and_then(|v| v.as_f64()) {
                Some(v) if v.is_finite() => parts.push(fmt_f32(v)),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            for key in STATE_INTS {
                match row.get(key).and_then(|v| v.as_i64()) {
                    Some(v) => parts.push(v.to_string()),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
        }
        if ok {
            rows.push(parts.join(" "));
        } else {
            skipped += 1;
        }
    }
    (rows, skipped)
}

fn meta_block(meta: &Meta) -> Vec<String> {
    let mut out = vec![format!("schema: {}", meta.schema)];
    if let Some(base) = meta.base {
        out.push(format!("base: {base}"));
    }
    if let Some(layout) = &meta.layout {
        out.push(format!("layout: {layout}"));
    }
    if let Some(variant) = meta.variant {
        out.push(format!("variant: {variant}"));
    }
    out.push(format!("fps: {}", meta.fps));
    out.push(format!("tap_down_ms: {}", meta.tap_down_ms));
    if let Some(anchor) = &meta.anchor {
        out.push(format!("anchor: {anchor}"));
    }
    out.push(format!("jumps: {}", meta.jumps));
    if let Some(created) = &meta.created {
        out.push(format!("created: {created}"));
    }
    if let Some(shot) = &meta.screenshot {
        out.push(format!("screenshot: {shot}"));
    }
    out
}

fn trap_block(traps: &[Trap]) -> Vec<String> {
    let mut out = vec!["traps:".to_string()];
    for t in traps {
        out.push(format!(
            "  - {{ slot: {}, type: {}, x: {}, y: {} }}",
            t.slot, t.kind, t.x, t.y
        ));
    }
    out
}

/// Собрать текст файла. Разделы, для которых нет данных, не пишутся вовсе.
fn render(replay: &Replay, rows: &[String], script: &str) -> Vec<String> {
    let mut out = Vec::new();
    let title = match replay.meta.base {
        Some(base) => format!("# base {base}"),
        None => "# replay".to_string(),
    };
    let title = match &replay.meta.created {
        Some(created) => format!("{title} — {created}"),
        None => title,
    };
    out.push(title);
    out.push(String::new());
    if let Some(shot) = &replay.meta.screenshot {
        let alt = match replay.meta.base {
            Some(base) => format!("base {base}"),
            None => "replay".to_string(),
        };
        out.push(format!("![{alt}]({shot})"));
        out.push(String::new());
    }
    out.push("```yaml".into());
    out.extend(meta_block(&replay.meta));
    out.push("```".into());
    out.push(String::new());

    if !replay.traps.is_empty() {
        out.push("## Раскладка базы".into());
        out.push(String::new());
        out.push("```yaml".into());
        out.extend(trap_block(&replay.traps));
        out.push("```".into());
        out.push(String::new());
    }

    if !script.is_empty() {
        out.push("## План прыжков (резерв, если блока state нет)".into());
        out.push(String::new());
        out.push("```frames".into());
        out.push("delta: true".into());
        out.push(script.to_string());
        out.push("```".into());
        out.push(String::new());
    }

    if !rows.is_empty() {
        out.push("## Эталон состояния на момент прыжка".into());
        out.push(String::new());
        out.push("```state".into());
        out.push(STATE_HEADER.into());
        out.extend(rows.iter().cloned());
        out.push("```".into());
        out.push(String::new());
    }

    out
}

/// Скрипт шагов в миллисекундах: дельты от предыдущего шага, `+400ms`.
pub fn build_ms_script(steps: &[i64]) -> String {
    let mut lines = Vec::with_capacity(steps.len());
    let mut prev = 0i64;
    for step in steps {
        lines.push(format!("+{}ms", step - prev));
        prev = *step;
    }
    lines.join("\n")
}

/// Записать реплей атомарно (tmp + rename). Возвращает число строк состояния.
pub fn save_replay_md(path: &Path, replay: &Replay) -> Result<usize, ReplayIoError> {
    // Инвариант: сохранённый файл обязан читаться обратно. Прогон без прыжков
    // (только якорь) загрузчик отвергает — значит и записывать его незачем.
    let jumps = replay.events.iter().filter(|e| e.name == "jump").count();
    if jumps == 0 && replay.ms_steps.is_empty() {
        return Err(ReplayIoError::at(
            path,
            "в прогоне нет ни одного прыжка — сохранять нечего",
        ));
    }
    let script = if replay.ms_steps.is_empty() {
        build_frame_script(&replay.events, replay.anchor_frame)
    } else {
        build_ms_script(&replay.ms_steps)
    };
    let (rows, skipped) = state_rows(&replay.body_frames);
    if script.is_empty() && rows.is_empty() {
        return Err(ReplayIoError::at(
            path,
            "нет ни прыжков, ни эталона состояния — сохранять нечего",
        ));
    }
    if skipped > 0 {
        eprintln!("WARN replay: {skipped} строк состояния пропущено (неполные поля)");
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = render(replay, &rows, &script).join("\n");
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, text)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(rows.len())
}

// ------------------------------------------------------------
// Чтение: fence-парсер
// ------------------------------------------------------------
struct Block {
    info: String,
    body: String,
}

/// Разбор файла на fenced-блоки и прозу между ними. Незакрытый fence — ошибка:
/// файл обрезан, и молча дочитать его «до конца» было бы догадкой.
fn split_blocks(text: &str) -> Result<(Vec<Block>, Vec<String>), String> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut prose: Vec<String> = Vec::new();
    let mut open: Option<(String, Vec<String>)> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("```") {
            match open.take() {
                Some((info, body)) => {
                    if !rest.trim().is_empty() {
                        return Err(format!(
                            "закрывающий fence с хвостом {rest:?} — ожидался пустой"
                        ));
                    }
                    blocks.push(Block { info, body: body.join("\n") });
                }
                None => open = Some((rest.trim().to_ascii_lowercase(), Vec::new())),
            }
            continue;
        }
        match open.as_mut() {
            Some((_, body)) => body.push(line.to_string()),
            None => prose.push(line.to_string()),
        }
    }
    if let Some((info, _)) = open {
        return Err(format!("fence ```{info} не закрыт"));
    }
    Ok((blocks, prose))
}

#[derive(Debug, Clone, PartialEq)]
enum Unit {
    Frames,
    Millis,
}

#[derive(Debug, Clone)]
enum Op {
    Num(i64),
    Ms(i64),
    Loop(usize, Vec<Op>),
}

fn parse_loop_open(s: &str) -> Option<usize> {
    let rest = s.strip_prefix("loop")?.trim_start();
    let num_part = rest.strip_suffix('{')?.trim();
    if num_part.is_empty() || !num_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    num_part.parse().ok()
}

/// Значение шага: кадры (`+20`, `20`) или миллисекунды (`+400ms`).
fn parse_step_value(s: &str) -> Option<(Unit, i64)> {
    let t = s.strip_suffix(',').unwrap_or(s).trim();
    let lower = t.to_ascii_lowercase();
    if let Some(number) = lower
        .strip_suffix("ms")
        .or_else(|| lower.strip_suffix("мс"))
    {
        return Some((Unit::Millis, number.trim().parse().ok()?));
    }
    let value = t
        .parse::<i64>()
        .ok()
        .or_else(|| t.strip_prefix('+')?.parse().ok())?;
    Some((Unit::Frames, value))
}

/// Скрипт кадров внутри блока `frames`: `delta: true|false`, `+N`, `loop N { }`.
/// Неизвестная строка — ошибка: опечатка в правленом руками файле не должна
/// молча менять план прыжков.
fn parse_frames_block(path: &Path, body: &str) -> Result<(bool, Unit, Vec<Op>), ReplayIoError> {
    let mut delta = false;
    let mut unit: Option<Unit> = None;
    let mut root: Vec<Op> = Vec::new();
    let mut stack: Vec<(usize, Vec<Op>)> = Vec::new();
    for (n, raw) in body.lines().enumerate() {
        let line = match raw.find("//") {
            Some(idx) => raw[..idx].trim(),
            None => raw.trim(),
        };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(value) = line.strip_prefix("delta:") {
            delta = matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes");
            continue;
        }
        if let Some(count) = parse_loop_open(line) {
            stack.push((count, Vec::new()));
            continue;
        }
        if line == "}" {
            let Some((count, body_ops)) = stack.pop() else {
                return Err(ReplayIoError::at(
                    path,
                    format!("frames, строка {}: лишняя '}}'", n + 1),
                ));
            };
            let op = Op::Loop(count, body_ops);
            match stack.last_mut() {
                Some((_, parent)) => parent.push(op),
                None => root.push(op),
            }
            continue;
        }
        match parse_step_value(line) {
            Some((step_unit, v)) => {
                match &unit {
                    Some(chosen) if *chosen != step_unit => {
                        return Err(ReplayIoError::at(
                            path,
                            format!(
                                "frames, строка {}: нельзя смешивать кадры и миллисекунды в одном блоке",
                                n + 1
                            ),
                        ));
                    }
                    _ => unit = Some(step_unit.clone()),
                }
                let op = match step_unit {
                    Unit::Frames => Op::Num(v),
                    Unit::Millis => Op::Ms(v),
                };
                match stack.last_mut() {
                    Some((_, body_ops)) => body_ops.push(op),
                    None => root.push(op),
                }
            }
            None => {
                return Err(ReplayIoError::at(
                    path,
                    format!("frames, строка {}: непонятная запись {line:?}", n + 1),
                ));
            }
        }
    }
    while let Some((count, body_ops)) = stack.pop() {
        let op = Op::Loop(count, body_ops);
        match stack.last_mut() {
            Some((_, parent)) => parent.push(op),
            None => root.push(op),
        }
    }
    Ok((delta, unit.unwrap_or(Unit::Frames), root))
}

fn exec_ops(ops: &[Op], mut cursor: i64, out: &mut Vec<i64>) -> i64 {
    for op in ops {
        match op {
            Op::Num(d) => {
                cursor += *d;
                out.push(cursor);
            }
            Op::Ms(d) => {
                cursor += *d;
                out.push(cursor);
            }
            Op::Loop(count, body) => {
                for _ in 0..*count {
                    cursor = exec_ops(body, cursor, out);
                }
            }
        }
    }
    cursor
}

fn flatten_abs(ops: &[Op], out: &mut Vec<i64>) {
    for op in ops {
        match op {
            Op::Num(v) => out.push(*v),
            Op::Ms(v) => out.push(*v),
            Op::Loop(_, body) => flatten_abs(body, out),
        }
    }
}

fn contains_loop(ops: &[Op]) -> bool {
    ops.iter().any(|op| matches!(op, Op::Loop(_, _)))
}

fn parse_state_block(path: &Path, body: &str) -> Result<Vec<Value>, ReplayIoError> {
    let mut rows = Vec::new();
    for (n, raw) in body.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() != 11 {
            return Err(ReplayIoError::at(
                path,
                format!("state, строка {}: {} колонок вместо 11", n + 1, parts.len()),
            ));
        }
        let frame: i64 = parts[0].parse().map_err(|_| {
            ReplayIoError::at(path, format!("state, строка {}: кадр {:?}", n + 1, parts[0]))
        })?;
        let mut obj = serde_json::Map::new();
        obj.insert("frame".into(), Value::from(frame));
        for (i, key) in STATE_FLOATS.iter().enumerate() {
            let v: f32 = parts[1 + i].parse().map_err(|_| {
                ReplayIoError::at(path, format!("state, строка {}: {key}={:?}", n + 1, parts[1 + i]))
            })?;
            obj.insert((*key).to_string(), Value::from(v as f64));
        }
        for (i, key) in STATE_INTS.iter().enumerate() {
            let v: i64 = parts[7 + i].parse().map_err(|_| {
                ReplayIoError::at(path, format!("state, строка {}: {key}={:?}", n + 1, parts[7 + i]))
            })?;
            obj.insert((*key).to_string(), Value::from(v));
        }
        rows.push(Value::Object(obj));
    }
    Ok(rows)
}

#[derive(Debug, Deserialize)]
struct TrapBlock {
    #[serde(default)]
    traps: Vec<Trap>,
}

fn sorted(mut v: Vec<i64>) -> Vec<i64> {
    v.sort_unstable();
    v
}

pub fn load_replay_md(path: &Path) -> Result<Replay, ReplayIoError> {
    let text = fs::read_to_string(path)?;
    parse_replay_md(path, &text)
}

/// Разбор текста файла. Отдельно от чтения с диска — чтобы тестировать без FS.
/// Что нашлось в блоках файла — до разбора плана.
struct Blocks {
    meta: Meta,
    traps: Vec<Trap>,
    script: Option<(bool, Unit, Vec<Op>)>,
    state: Option<Vec<Value>>,
}

/// Разложить fenced-блоки по смыслу: шапка, раскладка, скрипт плана, эталон.
/// Порядок блоков не важен, незнакомые info-string игнорируются.
fn collect_blocks(path: &Path, blocks: &[Block]) -> Result<Blocks, ReplayIoError> {
    let mut meta: Option<Meta> = None;
    let mut traps: Vec<Trap> = Vec::new();
    let mut script: Option<(bool, Unit, Vec<Op>)> = None;
    let mut state: Option<Vec<Value>> = None;

    for block in blocks {
        match block.info.as_str() {
            "yaml" => {
                if meta.is_none() && block.body.contains("schema:") {
                    let parsed: Meta = serde_yaml::from_str(&block.body)
                        .map_err(|e| ReplayIoError::at(path, format!("шапка: {e}")))?;
                    meta = Some(parsed);
                }
                if block.body.contains("traps:") {
                    let parsed: TrapBlock = serde_yaml::from_str(&block.body)
                        .map_err(|e| ReplayIoError::at(path, format!("раскладка: {e}")))?;
                    traps = parsed.traps;
                }
            }
            "frames" | "delta" => {
                if script.is_none() {
                    script = Some(parse_frames_block(path, &block.body)?);
                }
            }
            "state" => {
                if state.is_none() {
                    state = Some(parse_state_block(path, &block.body)?);
                }
            }
            _ => {}
        }
    }

    let Some(meta) = meta else {
        return Err(ReplayIoError::at(path, "нет yaml-блока с schema"));
    };
    if meta.schema != SCHEMA {
        return Err(ReplayIoError::at(
            path,
            format!("schema {} не поддерживается (ожидается {SCHEMA})", meta.schema),
        ));
    }
    Ok(Blocks { meta, traps, script, state })
}

pub fn parse_replay_md(path: &Path, text: &str) -> Result<Replay, ReplayIoError> {
    let clean = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let (blocks, _prose) = split_blocks(&clean).map_err(|e| ReplayIoError::at(path, e))?;
    let Blocks { meta, traps, script, state } = collect_blocks(path, &blocks)?;

    let (anchor_kind, anchor_frame) = match meta.anchor.as_deref() {
        Some(text) => match text.split_once('@') {
            Some((kind, frame)) => {
                let kind = kind.trim();
                (
                    if kind.is_empty() { None } else { Some(kind.to_string()) },
                    frame.trim().parse::<i64>().ok(),
                )
            }
            None => (Some(text.trim().to_string()), None),
        },
        None => (None, None),
    };

    // Раскрытие плана: кадры считаются от якоря, миллисекунды — от старта уровня.
    let mut ms_steps: Vec<i64> = Vec::new();
    let frames_from_script = match &script {
        Some((_delta, Unit::Millis, ops)) => {
            // Для времени нет «абсолютной» шкалы: шаги всегда отсчитываются от
            // старта уровня, поэтому delta не требуется.
            exec_ops(ops, 0, &mut ms_steps);
            None
        }
        Some((delta, Unit::Frames, ops)) => {
            let mut out = Vec::new();
            if *delta {
                let Some(anchor) = anchor_frame else {
                    return Err(ReplayIoError::at(
                        path,
                        "блок frames объявлен как delta, но anchor в шапке нет",
                    ));
                };
                exec_ops(ops, anchor, &mut out);
            } else {
                if contains_loop(ops) {
                    eprintln!("WARN replay: loop в абсолютном блоке frames — развёрнут один раз");
                }
                flatten_abs(ops, &mut out);
            }
            Some(out)
        }
        None => None,
    };

    // План в миллисекундах не совместим с покадровым эталоном: номера кадров
    // в нём ничего не значат.
    let state = if ms_steps.is_empty() {
        state
    } else {
        if state.as_ref().is_some_and(|rows| !rows.is_empty()) {
            eprintln!(
                "WARN replay: план в миллисекундах — блок state игнорируется (кадры к нему не относятся)"
            );
        }
        None
    };

    // В блоке state первой строкой идёт якорь (он же в шапке), дальше прыжки.
    // Для сравнения с frames якорь отбрасывается: в скрипте кадров дельты
    // считаются ОТ якоря, а не включают его.
    let frames_from_state = state.as_ref().map(|rows| {
        rows.iter()
            .filter_map(|row| row.get("frame").and_then(|v| v.as_i64()))
            .filter(|frame| Some(*frame) != anchor_frame)
            .collect::<Vec<i64>>()
    });

    let jump_frames = match (&frames_from_script, &frames_from_state) {
        (Some(script_frames), Some(state_frames)) => {
            if sorted(script_frames.clone()) != sorted(state_frames.clone()) {
                return Err(ReplayIoError::at(
                    path,
                    format!(
                        "блоки state ({}) и frames ({}) расходятся по прыжкам — файл противоречив",
                        state_frames.len(),
                        script_frames.len()
                    ),
                ));
            }
            sorted(state_frames.clone())
        }
        (None, Some(state_frames)) => sorted(state_frames.clone()),
        (Some(script_frames), None) => sorted(script_frames.clone()),
        (None, None) => {
            if ms_steps.is_empty() {
                return Err(ReplayIoError::at(
                    path,
                    "нет ни блока state, ни шагов в блоке frames",
                ));
            }
            Vec::new()
        }
    };
    if jump_frames.is_empty() && ms_steps.is_empty() {
        return Err(ReplayIoError::at(
            path,
            "в файле нет прыжков (только якорь) — играть нечего",
        ));
    }

    let mut events = Vec::with_capacity(jump_frames.len() + 1);
    if let Some(frame) = anchor_frame {
        events.push(ReplayEvent {
            frame,
            name: anchor_kind.clone().unwrap_or_else(|| "first_hero_update".into()),
        });
    }
    for frame in &jump_frames {
        events.push(ReplayEvent { frame: *frame, name: "jump".into() });
    }

    // Шапка пишется нами, но файл правят руками: расхождение — сигнал, а не
    // повод отказать (план всё равно берётся из блоков).
    let steps_total = jump_frames.len() + ms_steps.len();
    if meta.jumps != 0 && meta.jumps != steps_total {
        eprintln!(
            "WARN replay: в шапке jumps={}, а шагов в файле {steps_total}",
            meta.jumps
        );
    }

    let has_state = state.as_ref().is_some_and(|rows| !rows.is_empty());
    let body_frames = state.unwrap_or_default();

    Ok(Replay {
        meta,
        traps,
        anchor_frame,
        anchor_kind,
        events,
        body_frames,
        has_state,
        ms_steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body(frame: i64, px: f32, py: f32) -> Value {
        json!({
            "frame": frame,
            "px": px as f64,
            "py": py as f64,
            "ang": 0.0f32 as f64,
            "vx": 2.2f32 as f64,
            "vy": 0.0f32 as f64,
            "av": 0.0f32 as f64,
            "a0": 0,
            "b0": 1,
            "g80": 1,
            "g84": 0,
        })
    }

    fn sample() -> Replay {
        let mut replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(199_477_120),
                layout: Some("df5c0d85".into()),
                fps: 60.0,
                tap_down_ms: 1,
                variant: Some(2),
                anchor: Some("first_hero_update@100".into()),
                jumps: 3,
                created: Some("2026-11-28T15:51:03Z".into()),
                screenshot: Some("20261128-155103.png".into()),
            },
            traps: vec![
                Trap { slot: 0, kind: 1, x: 704, y: 498 },
                Trap { slot: 1, kind: 2, x: 64, y: 99 },
            ],
            anchor_frame: Some(100),
            anchor_kind: Some("first_hero_update".into()),
            events: Vec::new(),
            body_frames: vec![
                body(126, 434.5, 120.25),
                body(140, 435.0, 121.0),
                body(175, 440.5, 130.25),
            ],
            has_state: true,
            ms_steps: Vec::new(),
        };
        replay.events = events_for(&replay);
        replay
    }

    fn events_for(replay: &Replay) -> Vec<ReplayEvent> {
        let mut events = vec![ReplayEvent {
            frame: replay.anchor_frame.unwrap(),
            name: replay.anchor_kind.clone().unwrap_or_else(|| "first_hero_update".into()),
        }];
        for row in &replay.body_frames {
            if let Some(frame) = row.get("frame").and_then(|v| v.as_i64()) {
                events.push(ReplayEvent { frame, name: "jump".into() });
            }
        }
        events
    }

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kot_tas_replay_{tag}_{}_{}.md",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn markdown_roundtrip_keeps_jumps_state_and_traps() {
        let path = temp_path("roundtrip");
        let original = sample();
        let rows = save_replay_md(&path, &original).unwrap();
        assert_eq!(rows, 3);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# base 199477120"));
        assert!(text.contains("![base 199477120](20261128-155103.png)"));
        assert!(text.contains("- { slot: 0, type: 1, x: 704, y: 498 }"));

        let loaded = load_replay_md(&path).unwrap();
        assert_eq!(loaded.events, original.events);
        assert_eq!(loaded.body_frames, original.body_frames);
        assert_eq!(loaded.traps, original.traps);
        assert_eq!(loaded.meta.base, original.meta.base);
        assert_eq!(loaded.meta.layout.as_deref(), Some("df5c0d85"));
        assert_eq!(loaded.meta.variant, Some(2));
        assert!(loaded.has_state, "блок state записан и прочитан");
        assert_eq!(loaded.anchor_frame, Some(100));
        assert_eq!(loaded.anchor_kind.as_deref(), Some("first_hero_update"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn frames_only_file_still_plays() {
        let text = r#"
```yaml
schema: 1
base: 17
anchor: first_hero_update@1
jumps: 2
```

```frames
delta: true
+20
+30
```
"#;
        let replay = parse_replay_md(Path::new("memory.md"), text).unwrap();
        let jumps: Vec<i64> = replay
            .events
            .iter()
            .filter(|e| e.name == "jump")
            .map(|e| e.frame)
            .collect();
        assert_eq!(jumps, vec![21, 51]);
        assert!(replay.body_frames.is_empty());
        assert!(!replay.has_state, "файл без state должен это сообщать");
    }

    #[test]
    fn contradicting_blocks_are_rejected_instead_of_guessed() {
        let text = r#"
```yaml
schema: 1
anchor: first_hero_update@1
jumps: 1
```

```frames
delta: true
+20
```

```state
99 1 2 0 0 0 0 0 0 1 0
```
"#;
        let err = parse_replay_md(Path::new("clash.md"), text).unwrap_err();
        assert!(format!("{err}").contains("расходятся"), "{err}");
    }

    #[test]
    fn state_wins_when_both_blocks_agree() {
        let text = r#"
```yaml
schema: 1
anchor: first_hero_update@1
jumps: 1
```

```frames
delta: true
+20
```

```state
21 434.5 120.25 0 2.2 0 0 0 0 1 0
```
"#;
        let replay = parse_replay_md(Path::new("agree.md"), text).unwrap();
        assert_eq!(replay.body_frames.len(), 1);
        let jumps: Vec<i64> = replay
            .events
            .iter()
            .filter(|e| e.name == "jump")
            .map(|e| e.frame)
            .collect();
        assert_eq!(jumps, vec![21]);
    }

    #[test]
    fn foreign_schema_is_refused_and_json_fence_is_ignored() {
        let bad = r#"
```yaml
schema: 2
anchor: first_hero_update@1
jumps: 1
```

```frames
delta: true
+20
```
"#;
        let err = format!("{}", parse_replay_md(Path::new("bad.md"), bad).unwrap_err());
        assert!(err.contains("schema 2"), "{err}");

        let noisy = r#"
![x](data:image/png;base64,AAAABBBB)

```yaml
schema: 1
anchor: first_hero_update@1
jumps: 1
```

```json
{"frame": 999}
```

```frames
delta: true
+20
```
"#;
        let replay = parse_replay_md(Path::new("noisy.md"), noisy).unwrap();
        let jumps: Vec<i64> = replay
            .events
            .iter()
            .filter(|e| e.name == "jump")
            .map(|e| e.frame)
            .collect();
        assert_eq!(jumps, vec![21], "чужой json-блок не должен давать прыжков");
    }

    #[test]
    fn crlf_bom_broken_fence_and_short_state_row() {
        let crlf = "\u{feff}```yaml\r\nschema: 1\r\nanchor: first_hero_update@1\r\njumps: 1\r\n```\r\n\r\n```frames\r\ndelta: true\r\n+20\r\n```\r\n";
        let replay = parse_replay_md(Path::new("crlf.md"), crlf).unwrap();
        assert_eq!(replay.anchor_frame, Some(1));
        assert_eq!(replay.events.len(), 2);

        let unclosed = "```yaml\nschema: 1\n";
        let err = format!("{}", parse_replay_md(Path::new("cut.md"), unclosed).unwrap_err());
        assert!(err.contains("не закрыт"), "{err}");

        let stub = "```yaml\nschema: 1\nanchor: first_hero_update@1\njumps: 1\n```\n\n```frames\ndelta: true\n+20\n```\n\n```state\n21 1 2 0\n```\n";
        let err = format!("{}", parse_replay_md(Path::new("stub.md"), stub).unwrap_err());
        assert!(err.contains("колонок вместо 11"), "{err}");
    }

    #[test]
    fn typo_in_frames_is_reported_not_skipped() {
        let text = "```yaml\nschema: 1\nanchor: first_hero_update@1\njumps: 1\n```\n\n```frames\ndelta: true\n+2O\n```\n";
        let err = format!("{}", parse_replay_md(Path::new("typo.md"), text).unwrap_err());
        assert!(err.contains("непонятная запись"), "{err}");
    }

    /// Живой артефакт: в блоке state 8 строк (якорь + 7 прыжков), в frames — 7
    /// дельт. Раньше такой файл отвергался как противоречивый.
    #[test]
    fn recorded_file_with_anchor_row_loads() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/recorded-20261128-130615.md");
        let replay = load_replay_md(&path).expect("живой реплей должен читаться");
        let jumps: Vec<i64> = replay
            .events
            .iter()
            .filter(|e| e.name == "jump")
            .map(|e| e.frame)
            .collect();
        assert_eq!(jumps.len(), 7, "{jumps:?}");
        assert_eq!(replay.anchor_frame, Some(1));
        assert_eq!(replay.body_frames.len(), 8, "якорь + 7 прыжков");
        assert!(replay.traps.is_empty(), "в том прогоне раскладка не снялась");
    }

    #[test]
    fn loop_compression_survives_save_and_load() {
        let path = temp_path("loops");
        let mut replay = sample();
        replay.anchor_frame = Some(10);
        replay.meta.anchor = Some("first_hero_update@10".into());
        replay.body_frames = vec![
            body(36, 1.0, 1.0),
            body(50, 1.0, 2.0),
            body(101, 1.0, 3.0),
            body(152, 1.0, 4.0),
            body(203, 1.0, 5.0),
            body(263, 1.0, 6.0),
        ];
        replay.events = events_for(&replay);
        save_replay_md(&path, &replay).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("loop 3 {"), "{text}");
        let loaded = load_replay_md(&path).unwrap();
        assert_eq!(loaded.events, replay.events);
        fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod ms_tests {
    use super::*;

    fn frames_md(body: &str) -> String {
        format!(
            "```yaml\nschema: 1\nbase: 142614553\nlayout: dfc00cec\nanchor: first_hero_update@1\njumps: 0\n```\n\n```frames\n{body}\n```\n"
        )
    }

    /// Ручная правка `+400ms` — это шаги по стенным часам, не кадры.
    #[test]
    fn millisecond_steps_are_offsets_from_level_start() {
        let text = frames_md("delta: true\n+400ms\n+150ms");
        let replay = parse_replay_md(Path::new("ms.md"), &text).unwrap();
        assert_eq!(replay.ms_steps, vec![400, 550]);
        assert!(replay.body_frames.is_empty());
        assert!(!replay.has_state);
        assert_eq!(replay.events.len(), 1, "только якорь");
        assert_eq!(replay.events[0].name, "first_hero_update");
    }

    #[test]
    fn millisecond_loops_repeat() {
        let text = frames_md("delta: true\nloop 3 {\n+100ms\n}");
        let replay = parse_replay_md(Path::new("msloop.md"), &text).unwrap();
        assert_eq!(replay.ms_steps, vec![100, 200, 300]);
    }

    /// Кадры и миллисекунды в одном блоке — ошибка, а не молчаливый выбор.
    #[test]
    fn mixing_frames_and_milliseconds_is_rejected() {
        let text = frames_md("delta: true\n+20\n+400ms");
        let err = format!("{}", parse_replay_md(Path::new("mix.md"), &text).unwrap_err());
        assert!(err.contains("нельзя смешивать"), "{err}");
    }

    /// Покадровый эталон рядом с миллисекундным планом не применяется.
    #[test]
    fn state_is_ignored_for_millisecond_plans() {
        let text = frames_md("delta: true\n+400ms") + 
            "\n```state\n1 1 2 0 0 0 0 0 0 1 0\n120 1 2 0 0 0 0 0 0 1 0\n```\n";
        let replay = parse_replay_md(Path::new("msstate.md"), &text).unwrap();
        assert_eq!(replay.ms_steps, vec![400]);
        assert!(replay.body_frames.is_empty(), "кадры к ms-плану не относятся");
        assert!(!replay.has_state);
    }

    /// Живой файл: пользователь убрал блок state и вписал `+400ms` руками.
    #[test]
    fn recorded_millisecond_file_loads() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/recorded-ms-20261128-141951.md");
        let replay = load_replay_md(&path).expect("живой ms-реплей должен читаться");
        assert_eq!(replay.ms_steps, vec![400]);
        assert_eq!(replay.anchor_frame, Some(1));
        assert!(replay.body_frames.is_empty());
        assert!(!replay.has_state);
        assert_eq!(replay.traps.len(), 8, "раскладка сохранена в файле");
        assert_eq!(replay.meta.base, Some(1_032_192));
    }

    #[test]
    fn millisecond_plan_survives_save_and_load() {
        let path = std::env::temp_dir().join(format!(
            "kot_tas_ms_{}_{}.md",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(142_614_553),
                layout: Some("dfc00cec".into()),
                variant: Some(1),
                anchor: Some("first_hero_update@1".into()),
                jumps: 3,
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![ReplayEvent { frame: 1, name: "first_hero_update".into() }],
            ms_steps: vec![400, 550, 1600],
            ..Default::default()
        };
        save_replay_md(&path, &replay).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("+400ms"), "{text}");
        assert!(text.contains("+150ms"), "{text}");
        assert!(text.contains("+1050ms"), "{text}");
        assert!(!text.contains("```state"), "эталону состояния тут не место");
        let loaded = load_replay_md(&path).unwrap();
        assert_eq!(loaded.ms_steps, replay.ms_steps);
        assert_eq!(loaded.meta.variant, Some(1));
        fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod save_guard_tests {
    use super::*;

    /// Прогон без прыжков не должен превращаться в файл, который потом нельзя
    /// прочитать: именно так «только что записанный» реплей пропадал из выдачи.
    #[test]
    fn replay_without_jumps_is_not_saved() {
        let path = std::env::temp_dir().join(format!("kot_tas_guard_{}.md", std::process::id()));
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                anchor: Some("first_hero_update@1".into()),
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![ReplayEvent { frame: 1, name: "first_hero_update".into() }],
            body_frames: vec![serde_json::json!({
                "frame": 1, "px": 1.0, "py": 2.0, "ang": 0.0,
                "vx": 0.0, "vy": 0.0, "av": 0.0, "a0": 0, "b0": 0, "g80": 1, "g84": 0
            })],
            has_state: true,
            ms_steps: Vec::new(),
            traps: Vec::new(),
        };
        let err = save_replay_md(&path, &replay).unwrap_err();
        assert!(format!("{err}").contains("нет ни одного прыжка"), "{err}");
        assert!(!path.exists(), "файл не должен появиться");
    }
}
