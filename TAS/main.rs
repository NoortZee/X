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

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use frida::DeviceManager;

use crate::config::Config;
use crate::frida_agent::{attach_game_session, connect_remote_device, TasAgent, FRIDA};
use crate::orchestrator::Orchestrator;
use crate::phantom::PhantomBridge;
use crate::replay::{build_plan, find_anchor, load_replay, save_replay_atomic, Replay};
use crate::stones::{handle as stones_handle, StonesModule, HELP as STONES_HELP};

const MENU: &str = r#"
─────────────────────────────────────────────────
  Enter / rehearse    record + play
  record              only record
  play                only play
  calibrate           predict_lead_ms test (10 taps)
  dry-run             plan only, no taps
  catacombs start|status|dump|mark <label>|move-white|teleport-white|above|return-height|stop
  stones <filter>     rival stones live + burst-skip (см. help)
  help                справка по stones
  clear               wipe console + delete replay.json
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

fn prune_logs_dir(log_dir: &Path, replay_name: &str) {
    let _ = std::fs::create_dir_all(log_dir);
    if let Ok(entries) = std::fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name = p.file_name().and_then(|s| s.to_str());
            if name == Some(replay_name) {
                continue;
            }
            if p.is_file() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
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
    print!("{prompt}");
    let _ = io::stdout().flush();
    loop {
        if aborted.load(Ordering::SeqCst) {
            return None;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => return Some(line),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

fn do_record(
    agent: &mut TasAgent<'_>,
    cfg: &Config,
    replay_path: &Path,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
) {
    eprintln!("INFO main: === RECORD ===");
    println!("Войдите на уровень в замороженном состоянии.");
    if wait_enter_or_abort("Enter — НАЧАТЬ запись... ", rx, aborted).is_none() {
        eprintln!("WARN main: record cancelled before start");
        return;
    }

    if let Err(e) = agent.ensure_pump() {
        eprintln!("ERROR main: ensure_pump failed: {e}");
        return;
    }
    if let Err(e) = agent.detect_start() {
        eprintln!("ERROR main: detect_start failed: {e}");
        return;
    }

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
    let tl = agent.detect_get_frame_ns_timeline().unwrap_or_default();
    let rng = agent.detect_get_rng_log().unwrap_or(None);

    let (kind, anchor) = match find_anchor(&events, &body) {
        Some((k, f)) => (Some(k), Some(f)),
        None => (None, None),
    };
    let jumps_count = events.iter().filter(|e| e.name == "jump").count();

    let out = Replay {
        version: 3,
        anchor_frame: anchor,
        anchor_kind: kind.clone(),
        events,
        body_frames: body,
        timeline_ns: tl,
        rng_log: rng.map(|mut v| {
            v.truncate(2000);
            v
        }),
        ..Default::default()
    };

    if let Err(e) = save_replay_atomic(
        replay_path,
        &out,
        cfg.orchestrator.nominal_fps,
        cfg.phantom.tap_down_to_up_ms,
    ) {
        eprintln!("ERROR main: failed to save replay: {e}");
        return;
    }

    eprintln!(
        "INFO main: saved replay: {} events, {} body_frames, {} jumps, anchor={:?}@{:?}",
        out.events.len(),
        out.body_frames.len(),
        jumps_count,
        kind,
        anchor
    );
    if out.body_frames.is_empty() {
        eprintln!("WARN main: RECORD got 0 body_frames — проверьте pump_installed и memory/offsets.js (tas.fallback.FRAME_FUNC)");
    }
}

fn do_play(
    agent: &mut TasAgent<'_>,
    phantom: &mut PhantomBridge,
    cfg: &Config,
    replay_path: &Path,
    rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
) {
    let replay = load_replay(replay_path);
    if replay.events.is_empty() {
        if replay_path.exists() {
            println!("replay.json есть, но в нём нет events.");
            println!("Файл: {}", replay_path.display());
            println!("Похоже, файл повреждён — сделайте record заново.");
        } else {
            println!("нет replay.json — сначала record.");
        }
        return;
    }

    if replay.recovered {
        let mode = if replay.recovered_delta_mode {
            "delta"
        } else {
            "absolute"
        };
        println!(
            "⚠ replay.json без JSON-тела: восстановлено {} прыжков (mode={mode}); body_frames недоступны.",
            replay.recovered_jumps
        );
    }

    let jumps_n = replay.events.iter().filter(|e| e.name == "jump").count();
    println!(
        "anchor: {:?}={:?}, jumps={jumps_n}",
        replay.anchor_kind, replay.anchor_frame
    );
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
            if cfg.orchestrator.verify_body_frames {
                println!("   verify_body_frames: {}", rep.verify_body_frames);
            }
            println!("   report: console only (logs/replay.json is the only saved file)");
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
    let (x, y) = match cfg.tap.resolve() {
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

fn do_dry_run(replay_path: &Path) {
    let replay = load_replay(replay_path);
    if replay.events.is_empty() {
        println!("нет replay.json");
        return;
    }
    println!("=== DRY-RUN: plan only ===");
    let Some((kind, anchor)) = find_anchor(&replay.events, &replay.body_frames) else {
        println!("no anchor");
        return;
    };
    let plan = build_plan(&replay.events, anchor);
    println!("anchor={kind}@{anchor}");
    for p in &plan {
        println!(
            "  idx={:2}  rec_frame={:5}  delta={:4}",
            p.idx, p.rec_frame, p.frame_delta
        );
    }
    println!("total: {} jumps", plan.len());
    println!("   frame script: see logs/replay.json (block between \"\"\")");
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

    let log_dir = {
        let p = PathBuf::from(&cfg.logging.log_dir);
        if p.is_absolute() { p } else { root.join(p) }
    };
    let replay_path = log_dir.join("replay.json");
    prune_logs_dir(&log_dir, "replay.json");
    eprintln!(
        "INFO main: logging: console only; {} keeps only replay.json",
        log_dir.display()
    );

    let dm = DeviceManager::obtain(&FRIDA);
    let device = match connect_remote_device(&dm, &cfg.frida.device) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("ERROR main: remote device connect failed: {e}");
            std::process::exit(1);
        }
    };
    let session = match attach_game_session(&device, &cfg.frida.package) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ERROR main: attach failed: {e}");
            std::process::exit(1);
        }
    };

    let mut agent = match TasAgent::load(&session, &root.join("TAS").join("agent.js")) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("ERROR main: load TAS/agent.js failed: {e}");
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

    let mut catacombs_mod = catacombs::CatacombsModule::new(&session, root.clone());
    let mut stones_mod = StonesModule::new(
        &session,
        root.join("stones").join("rival_hook.js"),
        &cfg.stones,
        &cfg.telegram,
    );

    let aborted = Arc::new(AtomicBool::new(false));
    let in_cmd = Arc::new(AtomicBool::new(false));
    {
        let aborted_c = aborted.clone();
        let in_cmd_c = in_cmd.clone();
        let _ = ctrlc::set_handler(move || {
            if in_cmd_c.load(Ordering::SeqCst) {
                aborted_c.store(true, Ordering::SeqCst);
            } else {
                std::process::exit(0);
            }
        });
    }

    let stdin_rx = spawn_stdin_reader();

    loop {
        if session.is_detached() || agent.fatal.load(Ordering::SeqCst) {
            eprintln!("ERROR main: frida session lost");
            break;
        }
        println!("{MENU}");
        let Some(raw) = wait_enter_or_abort("> ", &stdin_rx, &aborted) else {
            break;
        };
        let cmd = raw.trim().to_ascii_lowercase();

        aborted.store(false, Ordering::SeqCst);
        in_cmd.store(true, Ordering::SeqCst);

        match cmd.as_str() {
            "" | "rehearse" | "r" => {
                do_record(&mut agent, &cfg, &replay_path, &stdin_rx, &aborted);
                if !aborted.load(Ordering::SeqCst) {
                    do_play(&mut agent, &mut phantom, &cfg, &replay_path, &stdin_rx, &aborted);
                }
            }
            "record" | "rec" => {
                do_record(&mut agent, &cfg, &replay_path, &stdin_rx, &aborted);
            }
            "play" | "p" => {
                do_play(&mut agent, &mut phantom, &cfg, &replay_path, &stdin_rx, &aborted);
            }
            "calibrate" | "cal" => {
                do_calibrate(&mut agent, &mut phantom, &cfg, &stdin_rx, &aborted);
            }
            "dry-run" | "dry" => do_dry_run(&replay_path),
            "help" | "h" | "?" => println!("{STONES_HELP}"),
            "clear" | "c" => {
                if replay_path.exists() {
                    if let Err(e) = std::fs::remove_file(&replay_path) {
                        eprintln!("WARN main: failed to delete {}: {e}", replay_path.display());
                    }
                }
                clear_console();
            }
            "exit" | "quit" | "q" => {
                in_cmd.store(false, Ordering::SeqCst);
                break;
            }
            s if s.split_whitespace().next() == Some("catacombs") => {
                let arguments = s.strip_prefix("catacombs").unwrap_or("").trim();
                if let Err(e) = catacombs_mod.command(arguments, &aborted) {
                    eprintln!("ERROR catacombs: {e}");
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

        in_cmd.store(false, Ordering::SeqCst);
        aborted.store(false, Ordering::SeqCst);
    }

    phantom.close();
    drop(catacombs_mod);
    drop(stones_mod);
    drop(agent);
    let _ = session.detach();
}
