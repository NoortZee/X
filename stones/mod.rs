use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use frida::{Message, Script, ScriptHandler, ScriptOption, Session};
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;

pub mod config;

use self::config::{StonesConfig, TelegramConfig};
use crate::phantom::PhantomBridge;

pub const HELP: &str = r#"=== stones — камни соперника (burst-режим) ===

  stones                     эта справка
  stones <filter>            автопоказ (Ctrl+C — выход)
  stones now                 текущий соперник (последний снимок)
  stones log [N]             последние N из журнала (default 10)
  stones reset               очистить журнал в агенте
  stones stop                detach хука
  stones clear               очистить консоль
  stones debug               диагностика rival_hook.js
  stones tg-test             отправить тестовое сообщение в Telegram
  help                       то же, что stones help

Фильтры (live + burst-тапы на non-match):
  stones gold 50000          gold >= 50000
  stones 1stone 100000       хотя бы 1 камень rating >= 100000
  stones 2stone 100000       хотя бы 2 камня  rating >= 100000
  stones 3stone 200000       все камни rating >= 200000

Во время LIVE:
  stones <new filter>        сменить фильтр (сброс state)
  clear  /  stones clear     очистить консоль
  stones now                 показать последний снимок
  stones tg-test             тест Telegram
  stones stop                выйти в меню
  Ctrl+C                     выйти в меню
"#;

#[derive(Error, Debug)]
pub enum StonesError {
    #[error("frida error: {0}")]
    Frida(#[from] frida::Error),
    #[error("rival_hook.js not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Source(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("bad RPC response from {0}: {1}")]
    BadRpc(String, String),
}

// ------------------------------------------------------------
// Rival DTOs
// ------------------------------------------------------------
#[derive(Debug, Clone, Deserialize, Default)]
pub struct StoneItem {
    pub slot: Option<i64>,
    pub rating: Option<i64>,
    pub cnt: Option<i64>,
    pub flag: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RivalSnap {
    #[serde(default)]
    pub ok: bool,
    pub reason: Option<String>,
    pub seq: Option<u64>,
    pub addr: Option<String>,
    pub gold: Option<i64>,
    pub player_level: Option<i64>,
    pub fraction: Option<f64>,
    pub n_items: Option<Value>,
    pub total_rating: Option<i64>,
    #[serde(default)]
    pub stones: Vec<StoneItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct RivalsListResp {
    #[serde(default)]
    rivals: Vec<RivalSnap>,
}

// ------------------------------------------------------------
// Filter
// ------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    Gold(i64),
    StonesAtLeast { count: usize, min_rating: i64 },
    AllStones { min_rating: i64 },
}

impl Filter {
    pub fn label(&self) -> String {
        match self {
            Filter::Gold(m) => format!("gold >= {m} "),
            Filter::StonesAtLeast { count, min_rating } => {
                format!(">= {count} stone(s) >= {min_rating} ")
            }
            Filter::AllStones { min_rating } => format!("all stones >= {min_rating} "),
        }
    }

    pub fn matches(&self, r: &RivalSnap) -> bool {
        match self {
            Filter::Gold(m) => r.gold.unwrap_or(0) >= *m,
            Filter::StonesAtLeast { count, min_rating } => {
                r.stones
                    .iter()
                    .filter_map(|s| s.rating)
                    .filter(|v| v >= min_rating)
                    .count()
                    >= *count
            }
            Filter::AllStones { min_rating } => {
                let mut any = false;
                for s in &r.stones {
                    if let Some(v) = s.rating {
                        any = true;
                        if v < *min_rating {
                            return false;
                        }
                    }
                }
                any
            }
        }
    }
}

fn parse_int_auto(s: &str) -> Option<i64> {
    let t = s.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok()
    } else {
        t.parse::<i64>().ok()
    }
}

fn looks_like_filter(sub: &str) -> bool {
    sub == "gold"
        || (sub.ends_with("stone")
            && sub.as_bytes().first().is_some_and(|b| b.is_ascii_digit()))
}

pub fn parse_filter(argv: &[&str]) -> Result<Option<Filter>, String> {
    if argv.is_empty() {
        return Ok(None);
    }
    let sub = argv[0].to_ascii_lowercase();
    if sub == "gold" {
        let arg = argv.get(1).ok_or("filter: gold requires MIN")?;
        let min = parse_int_auto(arg).ok_or_else(|| format!("bad MIN {arg:?}"))?;
        return Ok(Some(Filter::Gold(min)));
    }
    if looks_like_filter(&sub) {
        let cnt = (sub.as_bytes()[0] - b'0') as usize;
        if !(1..=3).contains(&cnt) || sub[1..] != *"stone" {
            return Err(format!("filter: count must be 1..3 in {sub:?}"));
        }
        let arg = argv
            .get(1)
            .ok_or_else(|| format!("filter: {sub} requires MIN"))?;
        let min = parse_int_auto(arg).ok_or_else(|| format!("bad MIN {arg:?}"))?;
        return if cnt >= 3 {
            Ok(Some(Filter::AllStones { min_rating: min }))
        } else {
            Ok(Some(Filter::StonesAtLeast {
                count: cnt,
                min_rating: min,
            }))
        };
    }
    Err(format!("unknown filter {sub:?} (use gold/1stone/2stone/3stone)"))
}

// ------------------------------------------------------------
// Telegram notifier
// ------------------------------------------------------------
pub struct TgNotifier {
    bot_token: String,
    chat_id: String,
    pub enabled: bool,
    timeout: Duration,
    pub min_interval: Duration,
    last_sent: Mutex<Option<Instant>>,
}

impl TgNotifier {
    pub fn from_config(cfg: &TelegramConfig) -> Self {
        let token = cfg.bot_token.trim().to_string();
        let chat_id = cfg.chat_id_str();
        let enabled = cfg.enabled && !token.is_empty() && !chat_id.is_empty();
        if cfg.enabled && !enabled {
            eprintln!("WARN telegram: enabled=true, но token/chat_id пустые — отключено");
        } else if enabled && token.starts_with("123456789:") {
            eprintln!("WARN telegram: используется placeholder bot_token из config.example.yaml!");
        }
        if enabled {
            eprintln!(
                "INFO telegram: enabled (chat_id={chat_id}, min_interval={:.0}s, timeout={:.0}s)",
                cfg.min_interval_s, cfg.timeout_s
            );
        }
        Self {
            bot_token: token,
            chat_id,
            enabled,
            timeout: Duration::from_secs_f64(cfg.timeout_s.max(1.0)),
            min_interval: Duration::from_secs_f64(cfg.min_interval_s.max(0.0)),
            last_sent: Mutex::new(None),
        }
    }

    fn should_send(&self) -> bool {
        if !self.enabled {
            return false;
        }
        let now = Instant::now();
        let mut guard = self.last_sent.lock().unwrap();
        if let Some(prev) = *guard {
            if now.duration_since(prev) < self.min_interval {
                return false;
            }
        }
        *guard = Some(now);
        true
    }

    fn http_send(token: &str, chat_id: &str, timeout: Duration, text: &str) -> bool {
        let url = format!("https://api.telegram.org/bot{token}/sendMessage");
        match ureq::post(&url).timeout(timeout).send_form(&[
            ("chat_id", chat_id),
            ("text", text),
            ("parse_mode", "HTML"),
            ("disable_web_page_preview", "true"),
        ]) {
            Ok(resp) if resp.status() == 200 => true,
            Ok(resp) => {
                eprintln!("WARN telegram: HTTP {}", resp.status());
                false
            }
            Err(e) => {
                eprintln!("WARN telegram send failed: {e}");
                false
            }
        }
    }

    pub fn force_send(&self, text: &str) -> bool {
        if !self.enabled {
            return false;
        }
        Self::http_send(&self.bot_token, &self.chat_id, self.timeout, text)
    }

    fn format_rival(r: &RivalSnap) -> String {
        let seq = r
            .seq
            .map(|s| s.to_string())
            .unwrap_or_else(|| "?".into());
        let gold = r
            .gold
            .map(|v| v.to_string())
            .unwrap_or_else(|| "None".into());
        let lvl = r
            .player_level
            .map(|v| v.to_string())
            .unwrap_or_else(|| "None".into());
        let total = r
            .total_rating
            .map(|v| v.to_string())
            .unwrap_or_else(|| "None".into());
        let mut lines = vec![format!("seq={seq} gold={gold} lvl={lvl} total={total}")];
        for s in &r.stones {
            if let Some(rating) = s.rating {
                lines.push(format!(
                    "  slot={:?} rating={rating} cnt={:?} flag={:?}",
                    s.slot, s.cnt, s.flag
                ));
            }
        }
        lines.join("\n")
    }

    pub fn notify_match(&self, rivals: &[RivalSnap], filter_label: &str) {
        if !self.should_send() {
            return;
        }
        let label = if filter_label.is_empty() {
            "none"
        } else {
            filter_label.trim()
        };
        let mut parts = vec![format!("🎯 <b>MATCH</b> — filter: {label}")];
        for r in rivals {
            parts.push(String::new());
            parts.push(Self::format_rival(r));
        }
        let text = parts.join("\n");
        let token = self.bot_token.clone();
        let chat_id = self.chat_id.clone();
        let timeout = self.timeout;
        thread::Builder::new()
            .name("tg-send".into())
            .spawn(move || {
                let _ = Self::http_send(&token, &chat_id, timeout, &text);
            })
            .ok();
    }
}

// ------------------------------------------------------------
// Hook source sanitizer
// ------------------------------------------------------------
const BAD_CHARS: &[char] = &[
    '\u{0085}', '\u{200B}', '\u{200C}', '\u{200D}', '\u{200E}', '\u{200F}', '\u{2060}', '\u{2061}',
    '\u{2062}', '\u{2063}', '\u{2064}', '\u{FEFF}',
];

const FOREIGN_MARKERS: &[&str] = &[
    "#!/usr/bin/env python",
    "#!/usr/bin/python",
    "\"\"\"",
    "r'''",
    "'''",
    "import ",
    "from __future__",
];

fn load_hook_source(path: &Path) -> Result<String, StonesError> {
    if !path.exists() {
        return Err(StonesError::NotFound(path.display().to_string()));
    }
    let bytes = std::fs::read(path)?;
    let slice = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let mut src = String::from_utf8_lossy(slice).into_owned();

    let head: String = src.trim_start().chars().take(200).collect();
    for m in FOREIGN_MARKERS {
        if head.starts_with(m) {
            return Err(StonesError::Source(format!(
                "rival_hook.js содержит не JavaScript, а чужой файл (начинается с {m:?})"
            )));
        }
    }

    src = src
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{2028}', '\u{2029}'], "\n");
    src.retain(|c| !BAD_CHARS.contains(&c));
    Ok(crate::memory::prepend_layout(path, &src)?)
}

// ------------------------------------------------------------
// Frida handler & StonesModule
// ------------------------------------------------------------
struct RivalHandler {
    live: Arc<AtomicBool>,
    tx: mpsc::Sender<u64>,
}

impl ScriptHandler for RivalHandler {
    fn on_message(&mut self, message: Message, _data: Option<Vec<u8>>) {
        match message {
            Message::Send(msg) => {
                let p = &msg.payload;
                let t = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match t {
                    "rival_update" => {
                        if self.live.load(Ordering::Relaxed) {
                            if let Some(seq) = p.get("seq").and_then(|v| v.as_u64()) {
                                let _ = self.tx.send(seq);
                            }
                        }
                    }
                    "ready" => eprintln!("INFO rival: ready base={:?}", p.get("base")),
                    "rival_aob" => eprintln!(
                        "INFO rival: rival_aob method={:?} offset={:?}",
                        p.get("method"),
                        p.get("offset")
                    ),
                    "hooked" => eprintln!(
                        "INFO rival: hooked at {:?} offset={:?}",
                        p.get("at"),
                        p.get("offset")
                    ),
                    "rival_data_suspect" => eprintln!(
                        "WARN rival: suspect data seq={:?} issues={:?}",
                        p.get("seq"),
                        p.get("issues")
                    ),
                    "rival_data_invalid" => {
                        println!("\n================================================================");
                        println!("!!!  RIVAL DATA INVALID — offsets или AOB устарели  !!!");
                        println!("================================================================");
                        println!("msg: {:?}", p.get("msg"));
                        println!("hint: {:?}", p.get("hint"));
                        println!("================================================================\n");
                    }
                    "err" => eprintln!(
                        "ERROR rival: where={:?} msg={:?}",
                        p.get("where"),
                        p.get("msg")
                    ),
                    _ => {}
                }
            }
            Message::Error(e) => eprintln!("ERROR [rival frida] {}", e.description),
            Message::Log(l) => eprintln!("[rival {:?}] {}", l.level, l.payload),
            Message::Other(v) => eprintln!("ERROR [rival frida] {v}"),
        }
    }
}

pub struct StonesModule<'a> {
    session: &'a Session<'a>,
    hook_path: PathBuf,
    script: Option<Script<'a>>,
    live_flag: Arc<AtomicBool>,
    seq_tx: mpsc::Sender<u64>,
    seq_rx: mpsc::Receiver<u64>,

    pub skip_xy: Option<(i32, i32)>,
    pub skip_wait_ms: u64,
    pub burst_interval_ms: u64,
    pub stall_timeout_ms: u64,
    pub burst_pause_every: u64,
    pub burst_pause_ms: u64,
    pub tap_fail_abort: u32,
    pub health_check_interval_s: f64,
    pub verbose_output: bool,

    pub tg: TgNotifier,
    last_skip_t: Option<Instant>,
    tap_ok_count: u64,
}

impl<'a> StonesModule<'a> {
    pub fn new(
        session: &'a Session<'a>,
        hook_path: PathBuf,
        sc: &StonesConfig,
        tg_cfg: &TelegramConfig,
    ) -> Self {
        let (seq_tx, seq_rx) = mpsc::channel();
        let skip_xy = sc.skip_on_no_match.as_ref().map(|c| (c.x, c.y));
        let tg = TgNotifier::from_config(tg_cfg);
        if let Some((x, y)) = skip_xy {
            eprintln!(
                "INFO stones burst: tap ({x},{y}) wait={}ms burst={}ms stall={}ms pause={}/{}ms fail_abort={} hc={:.0}s verbose={} tg={}",
                sc.skip_wait_ms,
                sc.burst_interval_ms.max(10),
                sc.stall_timeout_ms.max(500),
                sc.burst_pause_every,
                sc.burst_pause_ms,
                sc.tap_fail_abort.max(1),
                sc.health_check_interval_s,
                sc.verbose_output,
                tg.enabled
            );
        }
        Self {
            session,
            hook_path,
            script: None,
            live_flag: Arc::new(AtomicBool::new(false)),
            seq_tx,
            seq_rx,
            skip_xy,
            skip_wait_ms: sc.skip_wait_ms,
            burst_interval_ms: sc.burst_interval_ms.max(10),
            stall_timeout_ms: sc.stall_timeout_ms.max(500),
            burst_pause_every: sc.burst_pause_every,
            burst_pause_ms: sc.burst_pause_ms,
            tap_fail_abort: sc.tap_fail_abort.max(1),
            health_check_interval_s: sc.health_check_interval_s,
            verbose_output: sc.verbose_output,
            tg,
            last_skip_t: None,
            tap_ok_count: 0,
        }
    }

    pub fn ensure_loaded(&mut self) -> Result<(), StonesError> {
        if self.script.is_some() {
            return Ok(());
        }
        let src = load_hook_source(&self.hook_path)?;
        let mut opts = ScriptOption::default();
        let mut script = self.session.create_script(&src, &mut opts)?;
        script.handle_message(RivalHandler {
            live: self.live_flag.clone(),
            tx: self.seq_tx.clone(),
        })?;
        script.load()?;
        let base = script.exports.call("moduleBase", None)?;
        eprintln!("INFO rival_hook loaded, module_base={base:?}");
        script.exports.call("installHooks", None)?;
        eprintln!("INFO rival_hook installed");
        self.script = Some(script);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.live_flag.store(false, Ordering::SeqCst);
        if let Some(mut s) = self.script.take() {
            let _ = s.exports.call("unhookAll", None);
            let _ = s.unload();
            eprintln!("INFO rival_hook stopped");
        }
    }

    fn call_rpc(&mut self, name: &str, args: Option<Value>) -> Result<Value, StonesError> {
        self.ensure_loaded()?;
        let s = self.script.as_mut().unwrap();
        Ok(s.exports.call(name, args)?.unwrap_or(Value::Null))
    }

    pub fn last(&mut self) -> Result<RivalSnap, StonesError> {
        let v = self.call_rpc("getLastRival", None)?;
        serde_json::from_value(v)
            .map_err(|e| StonesError::BadRpc("getLastRival".into(), e.to_string()))
    }

    pub fn log_rivals(&mut self) -> Result<Vec<RivalSnap>, StonesError> {
        let v = self.call_rpc("getRivalsLog", None)?;
        let parsed: RivalsListResp = serde_json::from_value(v)
            .map_err(|e| StonesError::BadRpc("getRivalsLog".into(), e.to_string()))?;
        Ok(parsed.rivals)
    }

    pub fn rivals_since(&mut self, since_seq: u64) -> Result<Vec<RivalSnap>, StonesError> {
        let v = self.call_rpc("getRivalsSince", Some(json!([since_seq])))?;
        let parsed: RivalsListResp = serde_json::from_value(v)
            .map_err(|e| StonesError::BadRpc("getRivalsSince".into(), e.to_string()))?;
        Ok(parsed.rivals)
    }

    pub fn reset(&mut self) -> bool {
        let Some(s) = self.script.as_mut() else {
            return false;
        };
        s.exports
            .call("resetLog", None)
            .ok()
            .flatten()
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    fn drain_pending(&self) -> Vec<u64> {
        let mut out = Vec::new();
        while let Ok(seq) = self.seq_rx.try_recv() {
            out.push(seq);
        }
        out
    }

    fn do_skip(&mut self, phantom: &mut PhantomBridge) -> bool {
        let Some((x, y)) = self.skip_xy else {
            return false;
        };
        let since_last = self
            .last_skip_t
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let tr = phantom.tap(x, y);
        self.last_skip_t = Some(Instant::now());
        if tr.ok {
            self.tap_ok_count += 1;
            if self.verbose_output || self.tap_ok_count <= 10 || self.tap_ok_count % 10 == 0 {
                println!(
                    "   (skip: tap {x},{y}  {:.1}ms  [+{since_last:.0}ms]  #{})",
                    tr.duration_ms, self.tap_ok_count
                );
            }
            true
        } else {
            println!(
                "   (skip tap FAILED: {})",
                tr.error.as_deref().unwrap_or("unknown")
            );
            false
        }
    }
}

impl Drop for StonesModule<'_> {
    fn drop(&mut self) {
        self.stop();
    }
}

// ------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------
fn clear_console() {
    print!("\x1b[H\x1b[2J\x1b[3J");
    let _ = std::io::stdout().flush();
}

fn fmt_stones(stones: &[StoneItem]) -> String {
    let parts: Vec<String> = stones
        .iter()
        .filter_map(|s| Some(format!("{}:{}", s.slot?, s.rating?)))
        .collect();
    if parts.is_empty() {
        "—".into()
    } else {
        format!("({})", parts.join(", "))
    }
}

fn fmt_row(r: &RivalSnap) -> String {
    let seq = r.seq.map(|s| s.to_string()).unwrap_or_else(|| "?".into());
    let gold = r.gold.map(|v| v.to_string()).unwrap_or_else(|| "None".into());
    let lvl = r
        .player_level
        .map(|v| v.to_string())
        .unwrap_or_else(|| "None".into());
    let total = r
        .total_rating
        .map(|v| v.to_string())
        .unwrap_or_else(|| "None".into());
    format!(
        "seq={seq:>3} gold={gold:>8} lvl={lvl:>3} total={total:>7} stones={}",
        fmt_stones(&r.stones)
    )
}

fn print_stones_detail(r: &RivalSnap) {
    for s in &r.stones {
        if let Some(rating) = s.rating {
            println!(
                "        slot={:?} rating={rating} cnt={:?} flag={:?}",
                s.slot, s.cnt, s.flag
            );
        }
    }
}

// ------------------------------------------------------------
// LIVE mode
// ------------------------------------------------------------
#[derive(PartialEq, Eq)]
enum LiveState {
    Idle,
    Tapping,
    FrozenMatch,
    Stalled,
}

struct LiveCtx {
    filter: Option<Filter>,
    state: LiveState,
    next_tap_at: Option<Instant>,
    last_rival_at: Option<Instant>,
    taps_sent: u64,
    fail_streak: u32,
    last_health_check: Instant,
    pause_until: Option<Instant>,
    last_seen_seq: u64,
}

impl LiveCtx {
    fn new(filter: Option<Filter>) -> Self {
        Self {
            filter,
            state: LiveState::Idle,
            next_tap_at: None,
            last_rival_at: None,
            taps_sent: 0,
            fail_streak: 0,
            last_health_check: Instant::now(),
            pause_until: None,
            last_seen_seq: 0,
        }
    }

    fn reset_state(&mut self) {
        self.state = LiveState::Idle;
        self.next_tap_at = None;
        self.last_rival_at = None;
        self.taps_sent = 0;
        self.fail_streak = 0;
        self.pause_until = None;
    }

    fn label(&self) -> String {
        self.filter
            .as_ref()
            .map(Filter::label)
            .unwrap_or_else(|| "none".into())
    }
}

fn handle_live_line(line: &str, ctx: &mut LiveCtx, module: &mut StonesModule<'_>) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    if matches!(t.to_ascii_lowercase().as_str(), "clear" | "cls") {
        clear_console();
        println!("=== filter: {} ===", ctx.label());
        return true;
    }

    let parts: Vec<&str> = t.split_whitespace().collect();
    if !parts[0].eq_ignore_ascii_case("stones") {
        println!("(during LIVE: `stones <filter>`, `clear`, `stones stop`, Ctrl+C; ignored: {t:?})");
        return true;
    }
    if parts.len() == 1 {
        println!("{HELP}");
        return true;
    }

    let sub = parts[1].to_ascii_lowercase();
    match sub.as_str() {
        "help" | "?" | "-h" | "--help" => println!("{HELP}"),
        "stop" | "q" | "quit" | "exit" => {
            println!("\nLIVE stopped (by command).");
            return false;
        }
        "clear" | "cls" => {
            clear_console();
            println!("=== filter: {} ===", ctx.label());
        }
        "now" => match module.last() {
            Ok(r) if r.ok => {
                println!("[now] {}", fmt_row(&r));
                print_stones_detail(&r);
            }
            _ => println!("[now] no rival yet"),
        },
        "tg-test" | "tg_test" | "tgtest" => {
            if !module.tg.enabled {
                println!("telegram disabled (config.yaml: telegram.enabled / bot_token / chat_id)");
            } else {
                let ok = module.tg.force_send("🧪 <b>stones</b>: test message");
                println!(
                    "{}",
                    if ok {
                        "tg-test sent (check chat)"
                    } else {
                        "tg-test FAILED (см. лог)"
                    }
                );
            }
        }
        "live" => match parse_filter(&parts[2..]) {
            Ok(f) => {
                ctx.filter = f;
                ctx.reset_state();
                println!("=== filter: {} ===", ctx.label());
            }
            Err(e) => println!("bad filter: {e}"),
        },
        s if looks_like_filter(s) => match parse_filter(&parts[1..]) {
            Ok(f) => {
                ctx.filter = f;
                ctx.reset_state();
                println!("=== filter: {} ===", ctx.label());
            }
            Err(e) => println!("bad filter: {e}"),
        },
        _ => println!(
            "(during LIVE: `stones <filter>`, `clear`, `stones stop`, Ctrl+C; ignored: {t:?})"
        ),
    }
    true
}

pub fn stones_live(
    module: &mut StonesModule<'_>,
    phantom: &mut PhantomBridge,
    stdin_rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
    filter: Option<Filter>,
) -> Result<(), StonesError> {
    module.ensure_loaded()?;
    let _ = module.drain_pending();
    module.live_flag.store(true, Ordering::SeqCst);

    let mut ctx = LiveCtx::new(filter);
    println!();
    println!("=== filter: {} ===", ctx.label());
    if let Ok(r) = module.last() {
        if r.ok {
            println!("[prev] {}", fmt_row(&r));
            print_stones_detail(&r);
            if let Some(s) = r.seq {
                ctx.last_seen_seq = s;
            }
        }
    }

    println!("Слежение за Find a Match. Каждый новый соперник печатается автоматически.");
    println!("Во время LIVE: `stones <filter>` — фильтр, `clear` — консоль, `stones stop` — выход.");
    if ctx.filter.is_some() {
        if let Some((x, y)) = module.skip_xy {
            println!(
                "AUTO-SKIP (burst): non-match → tap ({x},{y})  wait={}ms  burst={}ms  stall={}ms",
                module.skip_wait_ms, module.burst_interval_ms, module.stall_timeout_ms
            );
            if module.burst_pause_every > 0 {
                println!(
                    "  Cooldown: каждые {} тапов → {}ms пауза",
                    module.burst_pause_every, module.burst_pause_ms
                );
            }
        } else {
            println!("AUTO-SKIP: отключён (нет stones.skip_on_no_match в config.yaml).");
        }
    }
    if module.tg.enabled {
        println!(
            "  TELEGRAM: enabled (min_interval={:.0}s)",
            module.tg.min_interval.as_secs_f64()
        );
    } else {
        println!("  TELEGRAM: disabled");
    }
    println!();

    let tick = Duration::from_millis(10);

    loop {
        if aborted.load(Ordering::SeqCst) {
            println!("\nLIVE stopped.");
            break;
        }
        if module.session.is_detached() {
            println!("\nLIVE ABORT: frida session detached");
            break;
        }

        // Wait up to 10ms on stdin so loop ticks at ~100Hz without busy-spinning
        if let Ok(line) = stdin_rx.recv_timeout(tick) {
            if !handle_live_line(&line, &mut ctx, module) {
                break;
            }
        }
        while let Ok(line) = stdin_rx.try_recv() {
            if !handle_live_line(&line, &mut ctx, module) {
                module.live_flag.store(false, Ordering::SeqCst);
                return Ok(());
            }
        }

        // Periodic health-check
        if module.health_check_interval_s > 0.0
            && ctx.last_health_check.elapsed().as_secs_f64() >= module.health_check_interval_s
        {
            ctx.last_health_check = Instant::now();
            if let Err(e) = module.call_rpc("moduleBase", None) {
                println!("\nLIVE ABORT: frida session dead: {e}");
                break;
            }
        }

        // Process incoming rivals (incremental RPC without raw_hex)
        let pending = module.drain_pending();
        if !pending.is_empty() {
            let mut rivals = module.rivals_since(ctx.last_seen_seq)?;
            rivals.sort_by_key(|r| r.seq.unwrap_or(0));
            if let Some(max_s) = rivals.iter().filter_map(|r| r.seq).max() {
                ctx.last_seen_seq = max_s;
            }
            ctx.last_rival_at = Some(Instant::now());

            let mut matched_rivals = Vec::new();
            let mut matched_seqs = Vec::new();
            let mut any_nonmatch = false;
            let mut nonmatch_after_match = false;

            for rr in &rivals {
                let seq = rr.seq.unwrap_or(0);
                let hit = ctx.filter.as_ref().map(|f| f.matches(rr));
                let marker = if hit == Some(true) { "  >>> MATCH <<<" } else { "" };
                println!("[{seq:>3}]{marker} {}", fmt_row(rr));
                if hit == Some(true) || module.verbose_output {
                    print_stones_detail(rr);
                }

                match hit {
                    Some(true) => {
                        matched_seqs.push(seq);
                        matched_rivals.push(rr.clone());
                    }
                    Some(false) => {
                        any_nonmatch = true;
                        if !matched_seqs.is_empty() {
                            nonmatch_after_match = true;
                        }
                    }
                    None => {}
                }
            }

            if ctx.filter.is_some() {
                if !matched_seqs.is_empty() {
                    let was_tapping = ctx.state == LiveState::Tapping;
                    ctx.state = LiveState::FrozenMatch;
                    ctx.next_tap_at = None;
                    if was_tapping {
                        println!("   (MATCH on seq {matched_seqs:?} — останавливаю тапы)");
                    } else {
                        println!("   (MATCH on seq {matched_seqs:?} — авто-скип НЕ делаю, стоп)");
                    }
                    if nonmatch_after_match {
                        println!("   (WARN: после MATCH в этой же пачке пришёл ещё соперник — проверьте экран!)");
                    }
                    if module.tg.enabled {
                        module.tg.notify_match(&matched_rivals, &ctx.label());
                        println!("   (telegram: уведомление отправляется)");
                    }
                } else if any_nonmatch && ctx.state != LiveState::FrozenMatch {
                    if ctx.state != LiveState::Tapping {
                        ctx.state = LiveState::Tapping;
                        ctx.next_tap_at =
                            Some(Instant::now() + Duration::from_millis(module.skip_wait_ms));
                        println!(
                            "   (burst START: первый тап через {}ms, interval={}ms)",
                            module.skip_wait_ms, module.burst_interval_ms
                        );
                    }
                }
            }
        }

        // Burst auto-skip
        if ctx.state == LiveState::Tapping && module.skip_xy.is_some() {
            let now = Instant::now();
            let stalled = ctx
                .last_rival_at
                .map(|t| now.duration_since(t) > Duration::from_millis(module.stall_timeout_ms))
                .unwrap_or(false);

            if stalled {
                println!(
                    "   (WARN: нет новых соперников {}ms — прекращаю тапы)",
                    module.stall_timeout_ms
                );
                ctx.state = LiveState::Stalled;
                ctx.next_tap_at = None;
            } else if ctx.pause_until.map(|p| now < p).unwrap_or(false) {
                // cooling down
            } else if ctx.next_tap_at.map(|t| now >= t).unwrap_or(false) {
                let ok = module.do_skip(phantom);
                ctx.taps_sent += 1;
                if ok {
                    ctx.fail_streak = 0;
                } else {
                    ctx.fail_streak += 1;
                    if ctx.fail_streak >= module.tap_fail_abort {
                        println!(
                            "\nLIVE ABORT: {} подряд FAILED-тапов — phantom/game dead",
                            ctx.fail_streak
                        );
                        break;
                    }
                }

                if module.burst_pause_every > 0
                    && ctx.taps_sent > 0
                    && ctx.taps_sent % module.burst_pause_every == 0
                {
                    ctx.pause_until =
                        Some(now + Duration::from_millis(module.burst_pause_ms));
                    println!(
                        "   (cooldown: {}ms после {} тапов)",
                        module.burst_pause_ms, ctx.taps_sent
                    );
                }
                ctx.next_tap_at = Some(now + Duration::from_millis(module.burst_interval_ms));
            }
        }
    }

    module.live_flag.store(false, Ordering::SeqCst);
    Ok(())
}

pub fn handle(
    module: &mut StonesModule<'_>,
    phantom: &mut PhantomBridge,
    stdin_rx: &mpsc::Receiver<String>,
    aborted: &AtomicBool,
    argv: &[&str],
) -> Result<(), StonesError> {
    if argv.is_empty() {
        println!("{HELP}");
        return Ok(());
    }
    let sub = argv[0].to_ascii_lowercase();
    match sub.as_str() {
        "help" | "?" | "-h" | "--help" => println!("{HELP}"),
        "now" => {
            let r = module.last()?;
            if !r.ok {
                println!("no rival yet — зайдите в Find a Match, пока идёт поиск.");
                if let Some(reason) = r.reason {
                    println!("  reason: {reason} seq={:?}", r.seq);
                }
                return Ok(());
            }
            println!("=== current rival ===");
            println!("{}", fmt_row(&r));
            println!("  addr={:?}", r.addr);
            println!("  fraction={:?}  n_items={:?}", r.fraction, r.n_items);
            print_stones_detail(&r);
        }
        "log" => {
            let n = argv
                .get(1)
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(10)
                .max(1);
            let rivals = module.log_rivals()?;
            if rivals.is_empty() {
                println!("журнал пуст — ещё не было Find a Match.");
                return Ok(());
            }
            let start = rivals.len().saturating_sub(n);
            let slice = &rivals[start..];
            println!("=== last {} rival(s) ===", slice.len());
            for r in slice {
                println!("{}", fmt_row(r));
            }
        }
        "reset" => {
            let ok = module.reset();
            println!(
                "{}",
                if ok {
                    "journal cleared"
                } else {
                    "journal not cleared (hook not loaded?)"
                }
            );
        }
        "stop" => {
            module.stop();
            println!("rival_hook stopped");
        }
        "clear" | "cls" => clear_console(),
        "tg-test" | "tg_test" | "tgtest" => {
            if !module.tg.enabled {
                println!("telegram disabled (config.yaml: telegram.enabled / bot_token / chat_id)");
            } else {
                let ok = module.tg.force_send("🧪 <b>stones</b>: test message");
                println!(
                    "{}",
                    if ok {
                        "tg-test sent (check chat)"
                    } else {
                        "tg-test FAILED (см. лог)"
                    }
                );
            }
        }
        "debug" => {
            if !module.hook_path.exists() {
                println!("rival_hook.js NOT FOUND: {}", module.hook_path.display());
                return Ok(());
            }
            let size = std::fs::metadata(&module.hook_path)
                .map(|m| m.len())
                .unwrap_or(0);
            println!("path: {}", module.hook_path.display());
            println!("size: {size} bytes");
            match load_hook_source(&module.hook_path) {
                Ok(src) => {
                    for (i, line) in src.lines().take(5).enumerate() {
                        println!("  L{:02}: {line}", i + 1);
                    }
                    println!("sanitized OK (not yet passed to Frida)");
                }
                Err(e) => println!("load failed: {e}"),
            }
        }
        "live" => match parse_filter(&argv[1..]) {
            Ok(f) => stones_live(module, phantom, stdin_rx, aborted, f)?,
            Err(e) => println!("bad filter: {e}"),
        },
        s if looks_like_filter(s) => match parse_filter(argv) {
            Ok(f) => stones_live(module, phantom, stdin_rx, aborted, f)?,
            Err(e) => println!("bad filter: {e}"),
        },
        _ => {
            println!("unknown subcommand: {sub}");
            println!("try: stones");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_matches_filters() {
        let f_gold = parse_filter(&["gold", "50000"]).unwrap().unwrap();
        let f_2stone = parse_filter(&["2stone", "100000"]).unwrap().unwrap();
        let f_3stone = parse_filter(&["3stone", "200000"]).unwrap().unwrap();

        let rival = RivalSnap {
            gold: Some(60_000),
            stones: vec![
                StoneItem { slot: Some(0), rating: Some(250_000), ..Default::default() },
                StoneItem { slot: Some(1), rating: Some(120_000), ..Default::default() },
            ],
            ..Default::default()
        };
        assert!(f_gold.matches(&rival));
        assert!(f_2stone.matches(&rival));
        assert!(!f_3stone.matches(&rival));
    }
}
