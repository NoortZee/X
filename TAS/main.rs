#[path = "../base/mod.rs"]
mod base;
mod capture;
mod library;
#[path = "../catacombs/mod.rs"]
mod catacombs;
mod config;
mod frida_agent;
mod memory;
mod orchestrator;
mod phantom;
mod replay;
#[path = "../stones/mod.rs"]
mod stones;
#[path = "../mystic/mod.rs"]
mod mystic;

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::Value;
use std::thread;
use std::time::Duration;

use frida::{Device, DeviceManager, Session};

use crate::config::Config;
use crate::frida_agent::{
    attach_game_session, connect_remote_device, AgentError, TasAgent, FRIDA,
};
use crate::orchestrator::Orchestrator;
use crate::phantom::PhantomBridge;
use crate::library::{
    base_layout, existing_screenshot, find_replay_for, format_replays, list_replays,
    next_variant, pick_replay, plural_ru, resolve_replay_arg, screenshot_of, show_replay_image,
    variants_label, ReplayMatch, ReplayVariant,
};
use crate::replay::{
    build_plan, find_anchor, load_replay_md, save_replay_md, Meta, Replay, ReplayEvent, Trap,
    SCHEMA,
};
use crate::base::{handle as base_handle, BaseModule, BaseSnapshot, HELP as BASE_HELP};
use crate::stones::{handle as stones_handle, StonesModule, HELP as STONES_HELP};
use crate::mystic::{MysticModule, HELP as MYSTIC_HELP};

const MENU: &str = r#"
─────────────────────────────────────────────────
  Enter / rehearse    record + play
  record              only record
  play [файл]         only play; без аргумента — реплей под текущую раскладку
  calibrate           predict_lead_ms test (10 taps)
  catacombs [1..10]    загрузить модуль; 1..10 — скорость персонажа (по умолчанию 1)
                       Ctrl+C — выгрузить модуль и вернуться в меню
  stones <filter>     rival stones live + burst-skip (см. help)
  mystic              Mystic Realm: загрузить модуль + памятка (Ctrl+C — выгрузить)
  replays             все записанные реплеи: скелет, раскладки, варианты
  base …              сохранение базы: сдвиг ловушки, reset (см. base)
                       перезапуск игры переподключается сам, base восстанавливается
  clear               очистить консоль (файлы реплеев не трогаются)
  exit / q            quit
─────────────────────────────────────────────────"#;

fn project_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("TAS").join("agent.js").exists() {
        return cwd;
    }
    if let Ok(exe) = std::env::current_exe() {
        for anc in exe.ancestors() {
            if anc.join("TAS").join("agent.js").exists() {
                return anc.to_path_buf();
            }
        }
    }
    cwd
}

/// Оставить в папке базы только `keep` последних прогонов. Пара «md + png»
/// удаляется вместе: картинка относится к своему прогону.
/// Оставить в папке базы только `keep` последних прогонов.
///
/// Кадр может быть общим для нескольких прогонов (второй вариант того же уровня
/// переиспользует снимок первого), поэтому картинка удаляется только если на неё
/// больше никто не ссылается.
fn prune_base_dir(dir: &Path, images: &Path, keep: usize) {
    if keep == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut runs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        runs.push((mtime, path));
    }
    if runs.len() <= keep {
        return;
    }
    runs.sort_by(|a, b| b.0.cmp(&a.0));
    let doomed: Vec<PathBuf> = runs.iter().skip(keep).map(|(_, path)| path.clone()).collect();

    // Что останется: ссылки этих файлов трогать нельзя.
    let root = images.parent().unwrap_or(dir);
    let mut referenced: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for path in list_replays(root) {
        if doomed.contains(&path) {
            continue;
        }
        if let Some(png) = screenshot_of(&path) {
            referenced.insert(png);
        }
    }

    for path in doomed {
        // Ссылку разрешаем до удаления файла: после него шапку уже не прочитать.
        let png = screenshot_of(&path);
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("WARN main: не удалил {}: {e}", path.display());
            continue;
        }
        if let Some(png) = png {
            if !referenced.contains(&png) {
                let _ = std::fs::remove_file(&png);
            }
        }
    }
}

/// Метка времени без внешних зависимостей: `20261128-155103` и ISO-8601.
fn stamp_pair() -> (String, String) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    (
        format!("{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}"),
        format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z"),
    )
}

/// Дни от 1970-01-01 в (год, месяц, день) — алгоритм Говарда Хиннанта.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn clear_console() {
    print!("\x1b[H\x1b[2J\x1b[3J");
    let _ = io::stdout().flush();
}

fn spawn_stdin_reader() -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("stdin-reader".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut lock = stdin.lock();
            let mut buf = String::new();
            loop {
                buf.clear();
                match lock.read_line(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = buf.trim_end_matches(['\r', '\n']).to_string();
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .expect("failed to spawn stdin reader");
    rx
}

fn wait_enter_or_abort(
    prompt: &str,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
) -> Option<String> {
    prompt_or_abort(prompt, rx, aborted, false)
}

/// Итог ожидания команды в меню.
enum Prompt {
    Line(String),
    /// Ctrl+C: команда отменена, меню остаётся.
    Aborted,
    /// Сессия с игрой потеряна (перезапуск или выгрузка процесса).
    Detached,
}

/// Ожидание команды, которое замечает потерю сессии: иначе выход из игры виден
/// только на следующей команде, и приложение висит на мёртвом RPC.

/// Menu prompt: Ctrl+C cancels the waited action but keeps the session in the menu.
fn prompt_or_abort(
    prompt: &str,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
    clear_on_abort: bool,
) -> Option<String> {
    print!("{prompt}");
    let _ = io::stdout().flush();
    loop {
        if aborted.load(Ordering::SeqCst) {
            // Consume the cancellation so the menu is usable again immediately.
            if clear_on_abort {
                aborted.store(false, Ordering::SeqCst);
            }
            return None;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => return Some(line),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// Скриншот, который снимает фоновый поток по сигналу агента.
struct PendingShot {
    png: Arc<Mutex<Option<Vec<u8>>>>,
    err: Arc<Mutex<Option<String>>>,
}

impl PendingShot {
    fn wait(&self) -> Result<Vec<u8>, String> {
        for _ in 0..100 {
            if let Some(bytes) = self.png.lock().unwrap().take() {
                return Ok(bytes);
            }
            if let Some(reason) = self.err.lock().unwrap().clone() {
                return Err(reason);
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err("скриншот не готов за 5 с".into())
    }
}

/// Взвести съёмку: кадр делается в момент первого обновления персонажа.
fn arm_screenshot(agent: &mut TasAgent<'_>, cfg: &Config) -> PendingShot {
    let png = Arc::new(Mutex::new(None));
    let err = Arc::new(Mutex::new(None));
    let (tx, rx) = mpsc::channel::<()>();
    agent.arm_first_hero_shot(tx);
    let shot_cfg = cfg.replays.screenshot.clone();
    let png_slot = png.clone();
    let err_slot = err.clone();
    let spawned = thread::Builder::new()
        .name("screenshot".into())
        .spawn(move || {
            if rx.recv_timeout(Duration::from_secs(180)).is_err() {
                *err_slot.lock().unwrap() = Some("не дождались first_hero_update".into());
                return;
            }
            match capture::screenshot(&shot_cfg) {
                Ok(bytes) => *png_slot.lock().unwrap() = Some(bytes),
                Err(e) => *err_slot.lock().unwrap() = Some(e),
            }
        });
    if let Err(e) = spawned {
        *err.lock().unwrap() = Some(format!("поток скриншота не запустился: {e}"));
    }
    PendingShot { png, err }
}

fn trap_from(value: &Value) -> Option<Trap> {
    Some(Trap {
        slot: value.get("slot")?.as_i64()?,
        kind: value.get("type")?.as_i64()?,
        x: value.get("x")?.as_i64()?,
        y: value.get("y")?.as_i64()?,
    })
}

/// Если под эту раскладку кадр уже есть — вернуть его ссылку и убрать дубль,
/// снятый в этом прогоне. Так переиспользование работает даже когда раскладка
/// стала известна только к концу записи.
fn adopt_existing_shot(
    replays_root: &Path,
    seed: Option<i64>,
    fingerprint: Option<&str>,
    images_dir: &Path,
    written_link: Option<&str>,
    written_path: &Path,
) -> Option<String> {
    let link = existing_screenshot(replays_root, seed, fingerprint)?;
    if written_link.is_some() {
        let same_file = Path::new(&link)
            .file_name()
            .map(|name| images_dir.join(name) == written_path)
            .unwrap_or(false);
        if !same_file {
            // Кадр этого прогона больше не нужен: под ту же раскладку есть готовый.
            let _ = std::fs::remove_file(written_path);
        }
    }
    Some(link)
}

/// Одна строка о том, что известно про базу перед записью.
fn layout_status(layout: &Value) -> String {
    if layout.is_null() {
        return "(раскладка не прочитана: файл ляжет в seed0, кадр будет новый)".to_string();
    }
    let seed = layout
        .get("seed")
        .and_then(|v| v.as_i64())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "—".into());
    let fingerprint = layout
        .get("layout")
        .and_then(|v| v.as_str())
        .unwrap_or("—");
    let traps = layout
        .get("traps")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    format!("(база: seed={seed} раскладка={fingerprint}, ловушек {traps})")
}

/// Диагностика: почему раскладки нет. Печатает состояние base-хуков, чтобы
/// причина была видна сразу, а не только как «папка seed0».
fn report_layout_failure(base: &mut BaseModule) {
    match base.status() {
        Ok(v) => {
            let agent = v.get("agent").unwrap_or(&Value::Null);
            eprintln!("WARN main: раскладка базы не прочитана");
            eprintln!(
                "      base: hooked={:?} parses={:?} level={:?}",
                agent.get("hooked"),
                agent.get("parses"),
                agent.get("level")
            );
            eprintln!(
                "      причина обычно одна: уровень не загружался при работающем TAS —\
                 вход в базу должен случиться после запуска TAS"
            );
        }
        Err(e) => eprintln!("WARN main: раскладка не прочитана, status недоступен: {e}"),
    }
}


/// Оставить в блоке `state` только кадры прыжков и якорь: полный покадровый
/// лог в файле не нужен, сверка при `play` идёт по этим кадрам.
fn state_at_jumps(body_frames: &[Value], anchor: Option<i64>, events: &[ReplayEvent]) -> Vec<Value> {
    use std::collections::BTreeSet;
    let mut keep: BTreeSet<i64> = events
        .iter()
        .filter(|e| e.name == "jump")
        .map(|e| e.frame)
        .collect();
    if let Some(a) = anchor {
        keep.insert(a);
    }
    body_frames
        .iter()
        .filter(|row| {
            row.get("frame")
                .and_then(|v| v.as_i64())
                .map(|f| keep.contains(&f))
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

fn do_record(
    agent: &mut TasAgent<'_>,
    base: &mut BaseModule,
    cfg: &Config,
    replays_root: &Path,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
) {
    eprintln!("INFO main: === RECORD ===");
    println!("Войдите на уровень в замороженном состоянии.");
    println!("(важно: уровень должен быть собран уже при работающем TAS —");
    println!(" раскладку читаем хуком загрузки уровня, а не из памяти после забега)");
    if wait_enter_or_abort("Enter — НАЧАТЬ запись... ", rx, aborted).is_none() {
        eprintln!("WARN main: record cancelled before start");
        return;
    }

    // Раскладку снимаем до забега: уровень уже загружен, а после финиша клиент
    // может собрать следующий уровень и перезаписать текущую базу.
    let mut layout = base_layout(base);
    if layout.is_null() {
        // Хук загрузки мог сработать на пару кадров позже: короткая повторная
        // попытка дешевле, чем запись в seed0 без снимка.
        for _ in 0..3 {
            thread::sleep(Duration::from_millis(100));
            layout = base_layout(base);
            if !layout.is_null() {
                break;
            }
        }
    }
    println!("{}", layout_status(&layout));

    if let Err(e) = agent.ensure_pump() {
        eprintln!("ERROR main: ensure_pump failed: {e}");
        return;
    }
    if let Err(e) = agent.detect_start() {
        eprintln!("ERROR main: detect_start failed: {e}");
        return;
    }
    // Кадр снимаем только если под эту пару (скелет, раскладка) его ещё нет:
    // второй вариант того же уровня — то же подземелье.
    let reusable_shot = existing_screenshot(
        replays_root,
        layout.get("seed").and_then(|v| v.as_i64()),
        layout.get("layout").and_then(|v| v.as_str()),
    );
    let shot = match &reusable_shot {
        Some(link) => {
            println!("кадр базы уже есть — переиспользую: {link}");
            None
        }
        None => {
            if layout.is_null() {
                println!("кадр снять не с чем сверить: раскладка не прочитана — снимаю новый");
            } else {
                println!("под эту раскладку кадра ещё нет — снимаю новый");
            }
            Some(arm_screenshot(agent, cfg))
        }
    };

    println!("🔴 запись... Играйте (первый тап — старт уровня).");
    if wait_enter_or_abort("Enter — ОСТАНОВИТЬ... ", rx, aborted).is_none() {
        eprintln!("WARN main: record stop forced by Ctrl+C");
    }

    let events = match agent.detect_stop() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("ERROR main: detect_stop failed: {e}");
            return;
        }
    };
    let body = agent.detect_get_body_frames().unwrap_or_default();

    let (kind, anchor) = match find_anchor(&events, &body) {
        Some((k, f)) => (Some(k), Some(f)),
        None => (None, None),
    };
    let jumps_count = events.iter().filter(|e| e.name == "jump").count();
    if jumps_count == 0 {
        eprintln!("ERROR main: в прогоне не было ни одного прыжка — файл не создан.");
        eprintln!("      реплей хранит прыжки (вызов jumpFn); проверьте, что тап доходит до");
        eprintln!("      игры и уровень разморожен (старт уровня — первый тап по экрану)");
        return;
    }

    if layout.is_null() {
        layout = base_layout(base);
    }
    if layout.is_null() {
        report_layout_failure(base);
    }
    let seed = layout.get("seed").and_then(|v| v.as_i64());
    let fingerprint = layout
        .get("layout")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let traps: Vec<Trap> = layout
        .get("traps")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(trap_from).collect())
        .unwrap_or_default();

    let (stem, created) = stamp_pair();
    let dir = replays_root.join(match seed {
        Some(s) => s.to_string(),
        None => "seed0".to_string(),
    });
    // Один и тот же уровень можно пройти по-разному: номер варианта считается
    // по паре (скелет, раскладка) и попадает в имя файла.
    let variant = next_variant(replays_root, seed, fingerprint.as_deref(), &dir, &stem);
    let name = format!("{stem}({variant})");
    let md_path = dir.join(format!("{name}.md"));
    // Картинки лежат в общем каталоге replays/images: рядом с реплеями они
    // мешали и дублировались при каждом прогоне одной базы.
    let images_dir = replays_root.join("images");
    let png_path = images_dir.join(format!("{name}.png"));
    let png_link = format!("../images/{name}.png");

    let mut screenshot = reusable_shot.clone();
    if let Some(shot) = shot {
        match shot.wait() {
            Ok(bytes) => {
                if let Err(e) = std::fs::create_dir_all(&images_dir) {
                    eprintln!("WARN main: каталог картинок не создан: {e}");
                }
                match std::fs::write(&png_path, bytes) {
                    Ok(()) => screenshot = Some(png_link.clone()),
                    Err(e) => eprintln!("WARN main: PNG не записан: {e}"),
                }
            }
            Err(e) => eprintln!("WARN main: скриншот базы не снят: {e}"),
        }
    }

    // Раскладка могла стать известной только сейчас: если под неё кадр уже есть,
    // предпочитаем его, а только что снятый дубль удаляем.
    if reusable_shot.is_none() {
        if let Some(link) = adopt_existing_shot(
            replays_root,
            seed,
            fingerprint.as_deref(),
            &images_dir,
            screenshot.as_deref(),
            &png_path,
        ) {
            println!("кадр базы уже был — переиспользую: {link}");
            screenshot = Some(link);
        }
    }

    let state = state_at_jumps(&body, anchor, &events);
    let state_rows = state.len();
    let has_state = state_rows > 0;
    let anchor_text = match (&kind, anchor) {
        (Some(k), Some(f)) => Some(format!("{k}@{f}")),
        _ => None,
    };
    let out = Replay {
        meta: Meta {
            schema: SCHEMA,
            base: seed,
            layout: fingerprint.clone(),
            variant: Some(variant),
            fps: cfg.orchestrator.nominal_fps,
            tap_down_ms: cfg.phantom.tap_down_to_up_ms,
            anchor: anchor_text,
            jumps: jumps_count,
            created: Some(created),
            screenshot,
        },
        traps: traps.clone(),
        anchor_frame: anchor,
        anchor_kind: kind.clone(),
        events,
        body_frames: state,
        has_state,
        ms_steps: Vec::new(),
    };

    if let Err(e) = save_replay_md(&md_path, &out) {
        eprintln!("ERROR main: failed to save replay: {e}");
        return;
    }
    prune_base_dir(&dir, &images_dir, cfg.replays.keep_per_base);

    eprintln!(
        "INFO main: сохранён реплей {} (вариант {variant}, ловушек {}, состояния {}, прыжков {}, seed={:?}, layout={:?})",
        md_path.display(),
        traps.len(),
        state_rows,
        jumps_count,
        seed,
        fingerprint
    );
    if traps.is_empty() {
        eprintln!("WARN main: раскладка базы не прочитана — traps пусты, папка seed0");
    }
    if state_rows == 0 {
        eprintln!("WARN main: нет полных значений на прыжках — останется только блок frames");
    }
    if state_rows > 0 && state_rows < jumps_count {
        eprintln!(
            "WARN main: состояния на прыжках меньше, чем прыжков ({state_rows} из {jumps_count})"
        );
    }
}
/// Фоновое слежение за текущим подземельем: клиент разобрал новый макет —
/// ищем точное совпадение (скелет и раскладка) и предлагаем сыграть.
/// Опрос идёт в менюшном цикле: RPC к Frida остаются в одном потоке.
struct DungeonWatch {
    /// Счётчик загрузок уровня, на котором строили последнее предложение.
    last_loads: Option<u64>,
    pending: Vec<ReplayVariant>,
    next_poll: std::time::Instant,
    disabled: bool,
}

impl DungeonWatch {
    fn new() -> Self {
        Self {
            last_loads: None,
            pending: Vec::new(),
            next_poll: std::time::Instant::now(),
            disabled: false,
        }
    }

    fn take_pending(&mut self) -> Vec<ReplayVariant> {
        std::mem::take(&mut self.pending)
    }

    /// Выбрать вариант из предложенных: `None` — последний (самый свежий).
    /// Неверный номер ничего не съедает — предложение остаётся доступным.
    fn pick(&mut self, want: Option<usize>) -> Result<Option<ReplayVariant>, String> {
        if self.pending.is_empty() {
            return Ok(None);
        }
        let chosen = match want {
            Some(n) if n >= 1 && n <= self.pending.len() => self.pending[n - 1].clone(),
            Some(n) => {
                return Err(format!("варианта {n} нет: предложено {}", self.pending.len()))
            }
            None => self.pending[self.pending.len() - 1].clone(),
        };
        self.pending.clear();
        Ok(Some(chosen))
    }

    /// Возвращает true, если что-то напечатал: приглашение нужно перерисовать.
    /// Живой макет: (скелет, подпись, счётчик загрузок). `None` — база
    /// неизвестна. Ошибка RPC выключает слежение: без модуля `base` следить нечем.
    fn live(&mut self, base: &mut BaseModule) -> Option<(Option<i64>, Option<String>, u64)> {
        let snap = match base.ensure_loaded().and_then(|()| base.dungeon_snapshot()) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("WARN main: слежение за базой выключено: {e}");
                self.disabled = true;
                return None;
            }
        };
        if snap.get("ok").and_then(|o| o.as_bool()) != Some(true) {
            return None;
        }
        let loads = snap.get("loads").and_then(|v| v.as_u64()).unwrap_or(0);
        let seed = snap.get("seed").and_then(|v| v.as_i64());
        let layout = snap
            .get("layout")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        Some((seed, layout, loads))
    }

    fn poll(&mut self, base: &mut BaseModule, replays_root: &Path) -> bool {
        if self.disabled {
            return false;
        }
        let now = std::time::Instant::now();
        if now < self.next_poll {
            return false;
        }
        self.next_poll = now + Duration::from_millis(300);

        let Some((seed, layout, loads)) = self.live(base) else {
            return false;
        };
        // База меняется только через загрузку уровня: разбор макета для этого
        // не годится, свой данж приходит один раз при старте игры.
        if self.last_loads == Some(loads) {
            return false;
        }
        self.last_loads = Some(loads);
        self.evaluate(seed, layout.as_deref(), replays_root)
    }

    /// Пересмотреть предложение без ожидания нового разбора. Нужно после
    /// `play`: база обычно остаётся той же (уровень не пройден до конца), а
    /// вариантов всё ещё несколько. Живой макет читается заново, поэтому если
    /// клиент успел разобрать другую базу, предложение будет уже по ней.
    fn refresh(&mut self, base: &mut BaseModule, replays_root: &Path) -> bool {
        if self.disabled {
            return false;
        }
        let Some((seed, layout, loads)) = self.live(base) else {
            self.pending.clear();
            return false;
        };
        self.last_loads = Some(loads);
        self.evaluate(seed, layout.as_deref(), replays_root)
    }

    fn evaluate(&mut self, seed: Option<i64>, layout: Option<&str>, replays_root: &Path) -> bool {
        match find_replay_for(replays_root, seed, layout) {
            ReplayMatch::Exact(variants) => {
                let seed_text = seed.map(|v| v.to_string()).unwrap_or_else(|| "—".into());
                let layout_text = layout.clone().unwrap_or_else(|| "—".into());
                println!(
                    "\n┌─ под текущую базу {}: seed={seed_text} раскладка={layout_text}",
                    variants_label(variants.len())
                );
                for (i, variant) in variants.iter().enumerate() {
                    println!("│  {}", variant.line(i + 1));
                }
                println!(
                    "└─ y — сыграть последний, y <номер> — конкретный, <номер> — показать png, dry-run — только план"
                );
                self.pending = variants;
                true
            }
            ReplayMatch::SkeletonOnly { count, newest } => {
                let seed_text = seed.map(|v| v.to_string()).unwrap_or_else(|| "—".into());
                let example = newest
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("файл.md");
                println!(
                    "\n… скелет seed={seed_text} знаком ({count} {}), но раскладка другая — play не предлагаю",
                    plural_ru(count, "запись", "записи", "записей")
                );
                println!(
                    "  сыграть всё равно: play! {example}, посмотреть другие реплеи этого скелета: replays"
                );
                self.pending.clear();
                true
            }
            ReplayMatch::None => {
                self.pending.clear();
                false
            }
        }
    }
}

/// Ожидание команды с периодическим тиком: слежение за базой печатает
/// предложение, не дожидаясь ввода, и приглашение перерисовывается.
fn prompt_or_detach_watch(
    prompt: &str,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
    session: &Session<'_>,
    mut tick: impl FnMut() -> bool,
) -> Prompt {
    print!("{prompt}");
    let _ = io::stdout().flush();
    let mut next_tick = std::time::Instant::now() + Duration::from_millis(300);
    loop {
        if aborted.load(Ordering::SeqCst) {
            return Prompt::Aborted;
        }
        if session.is_detached() {
            return Prompt::Detached;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => return Prompt::Line(line),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if std::time::Instant::now() >= next_tick {
                    next_tick = std::time::Instant::now() + Duration::from_millis(300);
                    if tick() {
                        print!("{prompt}");
                        let _ = io::stdout().flush();
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Prompt::Aborted,
        }
    }
}

/// Загрузить реплей и напечатать его шапку: путь, причина выбора, скелет,
/// подпись, размеры плана. Общее для `play` и `dry-run`.
fn load_for_play(path: &Path, reason: &str) -> Option<Replay> {
    let replay = match load_replay_md(path) {
        Ok(replay) => replay,
        Err(e) => {
            println!("{e}");
            return None;
        }
    };
    if replay.events.is_empty() && replay.ms_steps.is_empty() {
        println!("в {} нет ни прыжков, ни шагов — играть нечего.", path.display());
        return None;
    }
    let seed = replay
        .meta
        .base
        .map(|v| v.to_string())
        .unwrap_or_else(|| "—".into());
    let layout = replay.meta.layout.clone().unwrap_or_else(|| "—".into());
    println!("реплей: {} ({reason})", path.display());
    println!(
        "base={seed} layout={layout} ловушек={} прыжков={} состояния={}",
        replay.traps.len(),
        replay.meta.jumps,
        replay.body_frames.len()
    );
    if !replay.ms_steps.is_empty() {
        let steps: Vec<String> = replay.ms_steps.iter().map(|ms| format!("{ms}ms")).collect();
        println!(
            "план в миллисекундах от старта уровня ({} шагов): {}",
            replay.ms_steps.len(),
            steps.join(", ")
        );
        println!("  кадры и эталон состояния для такого плана не используются");
    } else if !replay.has_state {
        println!("⚠ в файле нет блока state — план берётся из резервного блока frames:");
        println!("  прыжки те же, сверить состояние персонажа будет не с чем");
    }
    Some(replay)
}

fn kind_text(replay: &Replay) -> &str {
    replay.anchor_kind.as_deref().unwrap_or("—")
}

fn do_play(
    agent: &mut TasAgent<'_>,
    phantom: &mut PhantomBridge,
    base: &mut BaseModule,
    cfg: &Config,
    replays_root: &Path,
    explicit: Option<&Path>,
    via: &str,
    force: bool,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
) {
    let (path, reason) = match explicit {
        Some(path) => (path.to_path_buf(), via.to_string()),
        None => match pick_replay(replays_root, base) {
            Some(found) => found,
            None => {
                println!("реплеев нет — сначала record.");
                return;
            }
        },
    };
    let Some(replay) = load_for_play(&path, &reason) else {
        return;
    };
    let Some(anchor) = replay.anchor_frame else {
        println!("в {} нет якоря — играть нельзя.", path.display());
        return;
    };

    // Подмена базы: подпись раскладки в файле должна совпасть с тем, что на
    // экране. Иначе тапы полетят по чужой расстановке.
    let live = base_layout(base);
    let live_fp = live
        .get("layout")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    match (&replay.meta.layout, &live_fp) {
        (Some(expected), Some(actual)) if expected != actual => {
            if force {
                println!("⚠ принудительный запуск: в файле {expected}, на экране {actual}");
                println!("  прыжки рассчитаны на другую расстановку — это ваш выбор");
            } else {
                println!("⚠ раскладка не та: в файле {expected}, на экране {actual} — играть нельзя.");
                println!(
                    "  Если всё же нужно: play! {}",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("файл")
                );
                return;
            }
        }
        (Some(_), None) => println!("⚠ раскладку на экране прочитать не удалось — играю как есть."),
        (None, _) => println!("⚠ в файле нет подписи раскладки — сверить нельзя."),
        _ => println!("✅ раскладка совпала: {}", replay.meta.layout.as_deref().unwrap_or("?")),
    }

    let jumps_n = replay.events.iter().filter(|e| e.name == "jump").count();
    println!("anchor: {}={anchor}, jumps={jumps_n}", kind_text(&replay));
    println!("Войдите на уровень в замороженном состоянии.");
    if wait_enter_or_abort("Enter — старт play... ", rx, aborted).is_none() {
        eprintln!("WARN main: play cancelled before start");
        return;
    }

    if let Err(e) = agent.ensure_pump() {
        eprintln!("ERROR main: ensure_pump failed: {e}");
        return;
    }

    let mut orch = match Orchestrator::new(cfg, &replay) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("ERROR main: play init failed: {e}");
            return;
        }
    };

    match orch.run(agent, phantom, aborted) {
        Ok(rep) => {
            let fe = &rep.frame_error_stats;
            println!(
                "✅ jumps: {}/{} (missed={}, covered_by_user_tap={}, retries={})",
                rep.jumps_fired,
                rep.jumps_planned,
                rep.jumps_missed,
                rep.covered_by_user_tap,
                rep.retries
            );
            println!(
                "   frame_error: min={:?} med={:?} max={:?} abs_med={:?} abs_max={:?}",
                fe.min, fe.med, fe.max, fe.abs_med, fe.abs_max
            );
            println!(
                "   tap ms: min={:.2} med={:.2} max={:.2}  (elapsed={:.1}s, wall_limit={})",
                rep.tap_stats_ms.min,
                rep.tap_stats_ms.med,
                rep.tap_stats_ms.max,
                rep.elapsed_s,
                rep.wall_limit_s
                    .map(|v| format!("{v:.0}s"))
                    .unwrap_or_else(|| "none".into())
            );
            if let Some(ms) = &rep.ms_stats {
                println!(
                    "   ms-план: отклонение от цели min={:+.1}ms med={:+.1}ms max={:+.1}ms",
                    ms.min, ms.med, ms.max
                );
            }
            if cfg.orchestrator.verify_body_frames {
                println!("   verify_body_frames: {}", rep.verify_body_frames);
            }
            println!("   report: console only; реплей остался в {}", path.display());
        }
        Err(e) => eprintln!("ERROR main: play failed: {e}"),
    }
}

fn do_calibrate(
    agent: &mut TasAgent<'_>,
    phantom: &mut PhantomBridge,
    cfg: &Config,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
) {
    println!("=== CALIBRATE (async, no gate) ===");
    println!("Нужен активный уровень — персонаж бежит, не frozen.");
    if wait_enter_or_abort("Enter — старт... ", rx, aborted).is_none() {
        eprintln!("WARN main: calibrate cancelled before start");
        return;
    }
    if let Err(e) = agent.ensure_pump() {
        eprintln!("ERROR main: ensure_pump failed: {e}");
        return;
    }
    let (x, y) = match cfg.tap.resolve(&cfg.screen) {
        Ok(xy) => xy,
        Err(e) => {
            eprintln!("ERROR main: {e}");
            return;
        }
    };
    let fps = cfg.orchestrator.nominal_fps.max(1.0);
    let mut leads = Vec::new();
    let mut tap_ms = Vec::new();

    for i in 0..10 {
        if aborted.load(Ordering::SeqCst) {
            return;
        }
        let cur = agent
            .play_state()
            .ok()
            .and_then(|s| s.frame)
            .unwrap_or(0);
        let prev = agent
            .ring_tail(1)
            .ok()
            .and_then(|v| v.into_iter().last())
            .unwrap_or_default();
        let a0_before = prev.get("a0").and_then(|v| v.as_i64());
        let g80_before = prev.get("g80").and_then(|v| v.as_i64());

        let tr = phantom.tap(x, y);
        if !tr.ok {
            println!("[{i}] tap failed: {}", tr.error.unwrap_or_default());
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        tap_ms.push(tr.duration_ms);
        thread::sleep(Duration::from_millis(200));

        let tail = agent.ring_tail(200).unwrap_or_default();
        let mut change_frame = None;
        let (mut prev_a, mut prev_g) = (a0_before, g80_before);
        for r in tail {
            let Some(f) = r.get("frame").and_then(|v| v.as_i64()) else {
                continue;
            };
            if f <= cur {
                continue;
            }
            let a = r.get("a0").and_then(|v| v.as_i64());
            let g = r.get("g80").and_then(|v| v.as_i64());
            let jumped = (prev_a == Some(0) && a.is_some_and(|v| v != 0))
                || (prev_g == Some(1) && g == Some(0));
            if jumped {
                change_frame = Some(f);
                break;
            }
            prev_a = a;
            prev_g = g;
        }

        match change_frame {
            None => {
                println!("[{i}] cur={cur} no change in 200ms");
                thread::sleep(Duration::from_millis(500));
            }
            Some(cf) => {
                let lead_frames = cf - cur;
                let lead_ms = (lead_frames as f64) * 1000.0 / fps;
                leads.push(lead_ms);
                println!(
                    "[{i}] cur={cur} → change@{cf} lead_frames={lead_frames} lead≈{lead_ms:.1}ms tap={:.1}ms",
                    tr.duration_ms
                );
                thread::sleep(Duration::from_millis(400));
            }
        }
    }

    if leads.is_empty() {
        println!("не удалось зафиксировать ни одного отклика");
        return;
    }
    leads.sort_by(|a, b| a.total_cmp(b));
    let n = leads.len();
    let med = leads[n / 2];
    let p95 = leads[((n as f64 * 0.95) as usize).min(n - 1)];
    println!(
        "\nsamples={n}  min={:.1}ms  med={med:.1}ms  p95={p95:.1}ms  max={:.1}ms",
        leads[0],
        leads[n - 1]
    );
    if !tap_ms.is_empty() {
        tap_ms.sort_by(|a, b| a.total_cmp(b));
        println!("tap_ms: med={:.1}ms", tap_ms[tap_ms.len() / 2]);
    }
    println!("\n⚠ калибровка шумит (FPS-джиттер). Дефолт predict_lead_ms=0 — работает лучше.");
}

fn do_dry_run(replays_root: &Path, base: &mut BaseModule, explicit: Option<&Path>) {
    let picked = match explicit {
        Some(path) => Some((path.to_path_buf(), "указан вручную".to_string())),
        None => pick_replay(replays_root, base),
    };
    let Some((path, reason)) = picked else {
        println!("реплеев нет — сначала record.");
        return;
    };
    let Some(replay) = load_for_play(&path, &reason) else {
        return;
    };
    for trap in replay.traps.iter().take(16) {
        println!(
            "  ловушка slot={:>3} type={:>3} @{},{}",
            trap.slot, trap.kind, trap.x, trap.y
        );
    }
    let Some((kind, anchor)) = find_anchor(&replay.events, &replay.body_frames) else {
        println!("no anchor");
        return;
    };
    println!("anchor={kind}@{anchor}");
    let plan = build_plan(&replay.events, anchor);
    for p in &plan {
        println!(
            "  idx={:2}  rec_frame={:5}  delta={:4}",
            p.idx, p.rec_frame, p.frame_delta
        );
    }
    println!("total: {} jumps", plan.len());
    println!("   блоки frames/state — в самом файле: {}", path.display());
}
fn main() {
    let root = project_root();
    let cfg_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config.yaml"));

    let cfg = match Config::load(&cfg_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ERROR main: {e}");
            std::process::exit(1);
        }
    };

    let replays_root = {
        let p = PathBuf::from(&cfg.replays.dir);
        if p.is_absolute() { p } else { root.join(p) }
    };
    if let Err(e) = std::fs::create_dir_all(&replays_root) {
        eprintln!("ERROR main: не создал каталог реплеев {}: {e}", replays_root.display());
        std::process::exit(1);
    }
    eprintln!(
        "INFO main: реплеи: {} (папка на базу, внутри md + png; хранить {} на базу)",
        replays_root.display(),
        cfg.replays.keep_per_base
    );

    // Report the display once so scaled coordinates are traceable in the log.
    // Not fatal: tap.position=explicit and absolute skip coords need no size.
    match cfg.screen.resolve() {
        Ok((w, h)) => eprintln!("INFO main: Waydroid display {w}x{h}; scaled tap coordinates follow it"),
        Err(e) => eprintln!("WARN main: {e}"),
    }

    let dm = DeviceManager::obtain(&FRIDA);
    let device = match connect_remote_device(&dm, &cfg.frida.device) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("ERROR main: remote device connect failed: {e}");
            std::process::exit(1);
        }
    };

    let mut phantom = match PhantomBridge::new(&cfg.phantom) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ERROR main: phantom init failed: {e}");
            std::process::exit(1);
        }
    };

    let aborted = Arc::new(AtomicBool::new(false));
    {
        // Ctrl+C cancels a running command and, in the menu, unloads the modules.
        // Either way the session survives; the menu is re-shown by the main loop.
        let aborted_c = aborted.clone();
        let _ = ctrlc::set_handler(move || aborted_c.store(true, Ordering::SeqCst));
    }

    let stdin_rx = spawn_stdin_reader();
    // Перезапуск игры рвёт frida-сессию: последнее состояние base переживает это
    // и восстанавливается вместе с хуками после переподключения.
    let mut base_state = BaseSnapshot::from_config(&cfg.base);

    loop {
        let Some(session) = wait_for_session(&device, &cfg.frida.package, &aborted) else {
            break;
        };
        match run_session(
            &session,
            &root,
            &cfg,
            &mut phantom,
            &stdin_rx,
            &aborted,
            &replays_root,
            &mut base_state,
        ) {
            SessionEnd::Quit => break,
            SessionEnd::Lost => {
                eprintln!(
                    "INFO main: соединение с игрой потеряно — жду перезапуск игры (Ctrl+C — выход)"
                );
                thread::sleep(Duration::from_millis(1000));
            }
        }
    }

    phantom.close();
}

/// Чем закончилась сессия с игрой.
enum SessionEnd {
    Quit,
    /// Сессия потеряна (перезапуск игры, выгрузка процесса) — надо подключиться заново.
    Lost,
}

/// Ждёт появления процесса игры и подключается к нему.
fn wait_for_session<'a>(
    device: &'a Device<'a>,
    package: &str,
    aborted: &AtomicBool,
) -> Option<Session<'a>> {
    let mut announced = false;
    loop {
        if aborted.load(Ordering::SeqCst) {
            return None;
        }
        match attach_game_session(device, package) {
            Ok(session) => return Some(session),
            Err(AgentError::ProcessNotFound(_)) => {
                if !announced {
                    eprintln!("INFO main: игра не запущена — жду запуск (Ctrl+C — выход)");
                    announced = true;
                }
            }
            Err(e) => {
                if !announced {
                    eprintln!("WARN main: attach failed: {e}; пробую снова");
                    announced = true;
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// Одна жизнь с игрой: хуки, меню, команды. Заканчивается выходом или потерей сессии.
fn run_session<'a>(
    session: &'a Session<'a>,
    root: &Path,
    cfg: &Config,
    mut phantom: &mut PhantomBridge,
    stdin_rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
    replays_root: &Path,
    base_state: &mut BaseSnapshot,
) -> SessionEnd {
    let mut agent = match TasAgent::load(session, &root.join("TAS").join("agent.js")) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("ERROR main: load TAS/agent.js failed: {e}");
            return SessionEnd::Lost;
        }
    };

    let mut base_mod = BaseModule::new(session, root.join("base").join("hook.js"), &cfg.base);
    base_mod.restore(base_state);
    // Хуки base стоят всегда: без них не прочитать раскладку базы (seed, подпись,
    // ловушки), а она нужна и записи, и сверке перед play. Хуки read-only, пока
    // не взведён reset.
    match base_mod.ensure_loaded() {
        Ok(()) => {
            if !base_state.enabled {
                // Пишем в игру только по явной команде/конфигу; здесь хуки стоят
                // исключительно ради чтения раскладки.
                let _ = base_mod.enable(false);
            }
            if base_state.enabled || base_state.reset.is_some() {
                eprintln!("INFO main: base восстановлен: {base_state:?}");
            } else {
                eprintln!("INFO main: base-хуки установлены (чтение раскладки для реплеев)");
            }
        }
        Err(e) => eprintln!("WARN main: base hooks not loaded: {e}"),
    }
    let mut catacombs_mod = catacombs::CatacombsModule::new(session, root.to_path_buf());
    let mut mystic_mod = MysticModule::new(session, root.to_path_buf());
    let mut stones_mod = StonesModule::new(
        session,
        root.join("stones").join("rival_hook.js"),
        &cfg.stones,
        &cfg.telegram,
        &cfg.screen,
    );
    // Слежение за текущей базой: пока меню ждёт ввода, опрашиваем разбор макета.
    let mut watch = DungeonWatch::new();

    let mut quit = false;
    loop {
        if session.is_detached() || agent.fatal.load(Ordering::SeqCst) {
            eprintln!("ERROR main: frida session lost");
            break;
        }
        // The menu is shown once per iteration: after each command and after Ctrl+C.
        println!("{MENU}");
        let raw = match prompt_or_detach_watch("> ", stdin_rx, aborted, session, || {
            watch.poll(&mut base_mod, replays_root)
        }) {
            Prompt::Line(line) => line,
            Prompt::Aborted => {
                // Ctrl+C in the menu unloads loaded modules (restoring what they patched) and returns to the menu.
                println!();
                aborted.store(false, Ordering::SeqCst);
                if let Some(state) = catacombs_mod.unload() {
                    println!("catacombs: unloaded ({state})");
                }
                if mystic_mod.is_loaded() {
                    if let Some(text) = mystic_mod.unload() {
                        println!("mystic: выгружен ({text})");
                    }
                }
                stones_mod.stop();
                continue;
            }
            Prompt::Detached => {
                eprintln!("ERROR main: frida session lost");
                break;
            }
        };
        let raw_trimmed = raw.trim();
        let cmd = raw_trimmed.to_ascii_lowercase();
        // Первое слово — команда (регистр не важен), остальное — аргумент как
        // набрано: путь к файлу нельзя приводить к нижнему регистру.
        let first = cmd.split_whitespace().next().unwrap_or("").to_string();
        let argument = raw_trimmed
            .split_whitespace()
            .nth(1)
            .map(|value| value.to_string());

        aborted.store(false, Ordering::SeqCst);

        match cmd.as_str() {
            "" | "rehearse" | "r" => {
                watch.take_pending();
                do_record(&mut agent, &mut base_mod, &cfg, &replays_root, &stdin_rx, &aborted);
                // Записан новый вариант — показываем, что теперь доступно.
                watch.refresh(&mut base_mod, &replays_root);
                if !aborted.load(Ordering::SeqCst) {
                    do_play(
                        &mut agent,
                        &mut phantom,
                        &mut base_mod,
                        &cfg,
                        &replays_root,
                        None,
                        "выбран по живой раскладке",
                        false,
                        &stdin_rx,
                        &aborted,
                    );
                    // После прогона база та же и вариантов по-прежнему несколько.
                    watch.refresh(&mut base_mod, &replays_root);
                }
            }
            "record" | "rec" => {
                watch.take_pending();
                do_record(&mut agent, &mut base_mod, &cfg, &replays_root, &stdin_rx, &aborted);
                watch.refresh(&mut base_mod, &replays_root);
            }
            _ if matches!(first.as_str(), "y" | "yes" | "go") => {
                let want = argument.as_deref().and_then(|n| n.parse::<usize>().ok());
                if argument.is_some() && want.is_none() {
                    println!("номер варианта должен быть числом");
                } else {
                    match watch.pick(want) {
                        Ok(Some(variant)) => {
                            let path = variant.path.clone();
                            println!("играю {} ({})", variant.label(), path.display());
                            do_play(
                                &mut agent,
                                &mut phantom,
                                &mut base_mod,
                                &cfg,
                                &replays_root,
                                Some(&path),
                                &format!("{} из предложения", variant.label()),
                                false,
                                &stdin_rx,
                                &aborted,
                            );
                            watch.refresh(&mut base_mod, &replays_root);
                        }
                        Ok(None) => println!(
                            "нечего предлагать: зайдите в базу, под которую есть запись с той же раскладкой"
                        ),
                        Err(message) => println!("{message}"),
                    }
                }
            }
            // Номер варианта открывает его PNG; `png 2` делает то же явно.
            _ if matches!(first.as_str(), "png" | "open" | "pic" | "img")
                || (first.parse::<usize>().is_ok() && argument.is_none()) =>
            {
                let want = match first.parse::<usize>() {
                    Ok(number) => Some(number),
                    Err(_) => argument.as_deref().and_then(|v| v.parse::<usize>().ok()),
                };
                if watch.pending.is_empty() {
                    println!(
                        "нечего показывать: предложения нет — зайдите в базу, под которую есть запись"
                    );
                } else {
                    let count = watch.pending.len();
                    let index = match want {
                        Some(n) if n >= 1 && n <= count => Some(n - 1),
                        Some(n) => {
                            println!("варианта {n} нет: предложено {count}");
                            None
                        }
                        None => Some(count - 1),
                    };
                    if let Some(index) = index {
                        let variant = watch.pending[index].clone();
                        println!("{} — {}", variant.label(), variant.path.display());
                        show_replay_image(&variant.path, &cfg.replays.viewer);
                    }
                }
            }
            // play / play! / force: аргумент — путь, имя файла внутри replays или last.
            _ if matches!(first.as_str(), "play" | "p" | "play!" | "p!" | "force") => {
                let force = matches!(first.as_str(), "play!" | "p!" | "force");
                let resolved = match argument.as_deref() {
                    Some(value) => match resolve_replay_arg(&replays_root, value) {
                        Ok(path) => Some(Some(path)),
                        Err(message) => {
                            println!("{message}");
                            None
                        }
                    },
                    None => Some(None),
                };
                if let Some(target) = resolved {
                    watch.take_pending();
                    do_play(
                        &mut agent,
                        &mut phantom,
                        &mut base_mod,
                        &cfg,
                        &replays_root,
                        target.as_deref(),
                        if force { "принудительный запуск" } else { "указан вручную" },
                        force,
                        &stdin_rx,
                        &aborted,
                    );
                    watch.refresh(&mut base_mod, &replays_root);
                }
            }
            "calibrate" | "cal" => {
                do_calibrate(&mut agent, &mut phantom, &cfg, &stdin_rx, &aborted);
            }
            _ if matches!(first.as_str(), "replays" | "rs" | "list") => {
                let live = base_layout(&mut base_mod);
                let current = match (
                    live.get("seed").and_then(|v| v.as_i64()),
                    live.get("layout").and_then(|v| v.as_str()),
                ) {
                    (Some(seed), Some(layout)) => Some((seed, layout.to_string())),
                    _ => None,
                };
                // "replays all" — вся коллекция; без аргумента — только то, что
                // относится к загруженному сейчас скелету.
                let all = matches!(
                    argument.as_deref().map(|a| a.to_ascii_lowercase()).as_deref(),
                    Some("all") | Some("все") | Some("every")
                );
                for line in format_replays(&replays_root, current, all) {
                    println!("{line}");
                }
                watch.refresh(&mut base_mod, &replays_root);
            }
            _ if matches!(first.as_str(), "dry-run" | "dry" | "dryrun") => {
                let resolved = match argument.as_deref() {
                    Some(value) => match resolve_replay_arg(&replays_root, value) {
                        Ok(path) => Some(Some(path)),
                        Err(message) => {
                            println!("{message}");
                            None
                        }
                    },
                    None => Some(None),
                };
                if let Some(target) = resolved {
                    do_dry_run(&replays_root, &mut base_mod, target.as_deref());
                    watch.refresh(&mut base_mod, &replays_root);
                }
            }
            "help" | "h" | "?" => {
                println!("{STONES_HELP}");
                println!("{BASE_HELP}");
                println!("{MYSTIC_HELP}");
            }
            "clear" | "c" => {
                clear_console();
                println!(
                    "файлы реплеев не удалены: они лежат в {}",
                    replays_root.display()
                );
            }
            "exit" | "quit" | "q" => {
                quit = true;
                break;
            }
            s if s.split_whitespace().next() == Some("catacombs") => {
                let arguments = s.strip_prefix("catacombs").unwrap_or("").trim();
                if let Err(e) = catacombs_mod.run(arguments, &aborted) {
                    eprintln!("ERROR catacombs: {e}");
                }
            }
            s if s.split_whitespace().next() == Some("mystic") => {
                let arguments = s.strip_prefix("mystic").unwrap_or("").trim();
                if let Err(e) = mystic_mod.run(arguments, aborted) {
                    eprintln!("ERROR mystic: {e}");
                }
            }
            s if s.split_whitespace().next() == Some("base") => {
                let parts: Vec<&str> = cmd.split_whitespace().collect();
                if let Err(e) = base_handle(&mut base_mod, &parts[1..]) {
                    eprintln!("ERROR main: base error: {e}");
                } else {
                    // Состояние переживает перезапуск игры вместе с переподключением.
                    *base_state = base_mod.snapshot();
                }
            }
            s if s.starts_with("stones") => {
                let parts: Vec<&str> = cmd.split_whitespace().collect();
                if parts.first().copied() == Some("stones") {
                    if let Err(e) = stones_handle(
                        &mut stones_mod,
                        &mut phantom,
                        &stdin_rx,
                        &aborted,
                        &parts[1..],
                    ) {
                        eprintln!("ERROR main: stones error: {e}");
                    }
                } else {
                    println!("unknown command: {cmd}");
                }
            }
            _ => println!("unknown command: {cmd}"),
        }

        aborted.store(false, Ordering::SeqCst);
    }

    drop(base_mod);
    drop(catacombs_mod);
    drop(mystic_mod);
    drop(stones_mod);
    drop(agent);
    let _ = session.detach();
    if quit {
        SessionEnd::Quit
    } else {
        SessionEnd::Lost
    }
}






#[cfg(test)]
mod prune_tests {
    use super::*;

    fn write(root: &Path, base: i64, variant: u32, link: &str) -> PathBuf {
        let dir = root.join(base.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("20260101-00000{variant}({variant}).md"));
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(base),
                variant: Some(variant),
                anchor: Some("first_hero_update@1".into()),
                jumps: 1,
                screenshot: Some(link.to_string()),
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![
                ReplayEvent { frame: 1, name: "first_hero_update".into() },
                ReplayEvent { frame: 31, name: "jump".into() },
            ],
            ..Default::default()
        };
        save_replay_md(&path, &replay).unwrap();
        path
    }

    /// Кадр общий для двух вариантов: удаление старого прогона не должно его уносить.
    #[test]
    fn pruning_keeps_a_screenshot_shared_with_a_newer_variant() {
        let root = std::env::temp_dir().join(format!("kot_tas_prune_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("1032192");
        let images = root.join("images");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("shared.png"), b"png").unwrap();

        write(&root, 1_032_192, 1, "../images/shared.png");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&root, 1_032_192, 2, "../images/shared.png");

        prune_base_dir(&dir, &images, 1);

        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "остался только свежий прогон");
        assert!(
            images.join("shared.png").exists(),
            "общий кадр обязан остаться: на него ссылается новый вариант"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod adopt_tests {
    use super::*;

    fn write_replay(root: &Path, base: i64, layout: &str, link: &str) -> PathBuf {
        let dir = root.join(base.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("20260101-000001(1).md");
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(base),
                layout: Some(layout.to_string()),
                variant: Some(1),
                anchor: Some("first_hero_update@1".into()),
                jumps: 1,
                screenshot: Some(link.to_string()),
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![
                ReplayEvent { frame: 1, name: "first_hero_update".into() },
                ReplayEvent { frame: 31, name: "jump".into() },
            ],
            ..Default::default()
        };
        save_replay_md(&path, &replay).unwrap();
        path
    }

    /// Раскладка стала известна только к концу записи: дубль кадра убираем,
    /// в файл идёт ссылка на уже существующий.
    #[test]
    fn late_layout_adopts_the_existing_screenshot() {
        let root = std::env::temp_dir().join(format!("kot_tas_adopt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("old.png"), b"png").unwrap();
        write_replay(&root, 1_032_192, "2a9ab8b2", "../images/old.png");

        let fresh = images.join("fresh.png");
        std::fs::write(&fresh, b"png").unwrap();
        let link = adopt_existing_shot(
            &root,
            Some(1_032_192),
            Some("2a9ab8b2"),
            &images,
            Some("../images/fresh.png"),
            &fresh,
        );
        assert_eq!(link.as_deref(), Some("../images/old.png"));
        assert!(!fresh.exists(), "дубль кадра должен исчезнуть");
        assert!(images.join("old.png").exists(), "готовый кадр не трогаем");

        // Раскладка не совпала — ничего не подменяем.
        let other = images.join("other.png");
        std::fs::write(&other, b"png").unwrap();
        assert!(adopt_existing_shot(
            &root,
            Some(1_032_192),
            Some("deadbeef"),
            &images,
            Some("../images/other.png"),
            &other,
        )
        .is_none());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
