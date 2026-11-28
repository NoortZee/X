use crate::base::config::BaseConfig;
use crate::stones::config::{StonesConfig, TelegramConfig};

use serde::Deserialize;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("config not found: {0}")]
    NotFound(String),
    #[error("failed to read config: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid YAML config: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("invalid tap config: {0}")]
    InvalidTap(String),
    #[error("invalid screen config: {0}")]
    InvalidScreen(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub phantom: PhantomConfig,
    pub tap: TapConfig,
    #[serde(default, deserialize_with = "screen_or_default")]
    pub screen: ScreenConfig,
    #[serde(default)]
    pub base: BaseConfig,
    #[serde(default)]
    pub stones: StonesConfig,
    #[serde(default)]
    pub telegram: TelegramConfig,
    pub orchestrator: OrchestratorConfig,
    pub frida: FridaConfig,
    #[serde(default)]
    pub replays: ReplaysConfig,
    /// Устаревшая секция `logging`: читается только ради совместимости.
    #[serde(default)]
    pub logging: Option<LoggingConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PhantomConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "d_2000")]
    pub connect_timeout_ms: u64,
    #[serde(default = "d_1000")]
    pub ping_timeout_ms: u64,
    #[serde(default = "d_async")]
    pub sync_mode: String,
    #[serde(default = "d_1")]
    pub tap_down_to_up_ms: u64,
    #[serde(default)]
    pub post_tap_wait_ms: u64,
    #[serde(default)]
    pub slot: u8,
    #[serde(default = "d_1_usize")]
    pub reconnect_attempts: usize,
}

/// Waydroid display size that every scaled coordinate is resolved against.
///
/// Nothing here is a guess: `start/start.sh` exports what `adb shell wm size`
/// reported for the running window, and an explicit `screen:` section wins when
/// the operator wants to pin a size instead.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ScreenConfig {
    pub width: Option<i32>,
    pub height: Option<i32>,
}

impl ScreenConfig {
    pub fn resolve(&self) -> Result<(i32, i32), ConfigError> {
        let w = match self.width {
            Some(v) => v,
            None => env_dim("KOT_TAS_SCREEN_WIDTH")?,
        };
        let h = match self.height {
            Some(v) => v,
            None => env_dim("KOT_TAS_SCREEN_HEIGHT")?,
        };
        if w < 1 || h < 1 {
            return Err(ConfigError::InvalidScreen(format!(
                "display {w}x{h} is not usable"
            )));
        }
        Ok((w, h))
    }
}

fn env_dim(name: &str) -> Result<i32, ConfigError> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<i32>().ok())
        .ok_or_else(|| {
            ConfigError::InvalidScreen(format!(
                "no Waydroid display size: set screen.width and screen.height in config.yaml, \
                 or launch through start/start.sh, which exports {name} from `adb shell wm size`"
            ))
        })
}

/// Scale a 0..=1 fraction of the display span to pixels.
pub fn scale_frac(frac: Option<f64>, span: i32, name: &str) -> Result<i32, ConfigError> {
    let f = frac.ok_or_else(|| ConfigError::InvalidTap(format!("missing {name}")))?;
    if !(0.0..=1.0).contains(&f) {
        return Err(ConfigError::InvalidTap(format!(
            "{name}={f} is outside 0..=1"
        )));
    }
    Ok((f * span as f64).round() as i32)
}

#[derive(Debug, Clone, Deserialize)]
pub struct TapConfig {
    pub position: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub x_frac: Option<f64>,
    pub y_frac: Option<f64>,
}

impl TapConfig {
    pub fn resolve(&self, screen: &ScreenConfig) -> Result<(i32, i32), ConfigError> {
        match self.position.as_str() {
            "explicit" => {
                let x = self
                    .x
                    .ok_or_else(|| ConfigError::InvalidTap("missing tap.x".into()))?;
                let y = self
                    .y
                    .ok_or_else(|| ConfigError::InvalidTap("missing tap.y".into()))?;
                Ok((x, y))
            }
            "fraction" => {
                let (w, h) = screen.resolve()?;
                Ok((
                    scale_frac(self.x_frac, w, "tap.x_frac")?,
                    scale_frac(self.y_frac, h, "tap.y_frac")?,
                ))
            }
            "center_lower_third" => {
                let (w, h) = screen.resolve()?;
                Ok((w / 2, (h * 2) / 3))
            }
            other => Err(ConfigError::InvalidTap(format!(
                "unknown tap.position={other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrchestratorConfig {
    #[serde(default = "d_60_f64")]
    pub nominal_fps: f64,
    #[serde(default)]
    pub predict_lead_ms: f64,
    #[serde(default)]
    pub predict_margin_ms: f64,
    #[serde(default = "d_3")]
    pub poll_interval_ms: u64,
    #[serde(default = "d_30")]
    pub post_tap_check_ms: u64,
    #[serde(default)]
    pub retry_on_miss: bool,
    #[serde(default = "d_50")]
    pub retry_delay_ms: u64,
    #[serde(default = "d_15_f64")]
    pub fire_hard_deadline_s: f64,
    pub wall_timeout_s: Option<f64>,
    #[serde(default)]
    pub verify_body_frames: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FridaConfig {
    pub device: String,
    pub package: String,
}

/// Устаревшая секция: каталог логов. Оставлена, чтобы старый config.yaml не
/// ломал запуск; при загрузке переносится в `replays.dir` с предупреждением.
#[derive(Debug, Clone, Deserialize)]
pub struct LoggingConfig {
    #[serde(default = "d_logs")]
    pub log_dir: String,
}

/// Скриншот базы делается снаружи игры (`adb exec-out screencap -p`), поэтому
/// кадр — это ровно то, что видит дисплей, а не пересобранное окно хоста.
#[derive(Debug, Clone, Deserialize)]
pub struct ScreenshotConfig {
    #[serde(default = "d_true")]
    pub enabled: bool,
    /// Серийник adb; пусто — единственное подключённое устройство.
    #[serde(default)]
    pub adb_device: String,
    #[serde(default = "d_5000")]
    pub timeout_ms: u64,
}

impl Default for ScreenshotConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            adb_device: String::new(),
            timeout_ms: 5000,
        }
    }
}

impl ScreenshotConfig {
    /// Серийник adb: из конфига, иначе из `KOT_TAS_ADB_DEVICE` — ровно то
    /// значение, с которым `start/start.sh` подключает Waydroid.
    pub fn resolved_device(&self) -> String {
        let direct = self.adb_device.trim();
        if !direct.is_empty() {
            return direct.to_string();
        }
        std::env::var("KOT_TAS_ADB_DEVICE")
            .ok()
            .map(|v| v.trim().to_string())
            .unwrap_or_default()
    }
}

/// Каталог реплеев и политика хранения.
#[derive(Debug, Clone, Deserialize)]
pub struct ReplaysConfig {
    #[serde(default = "d_replays")]
    pub dir: String,
    /// Сколько последних прогонов держать на одну базу (папку).
    #[serde(default = "d_keep")]
    pub keep_per_base: usize,
    /// Чем открывать PNG реплея по команде: имя программы в PATH.
    #[serde(default = "d_viewer")]
    pub viewer: String,
    #[serde(default)]
    pub screenshot: ScreenshotConfig,
}

impl Default for ReplaysConfig {
    fn default() -> Self {
        Self {
            dir: "replays".into(),
            keep_per_base: 10,
            viewer: "xdg-open".into(),
            screenshot: ScreenshotConfig::default(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        if !path.exists() {
            return Err(ConfigError::NotFound(path.display().to_string()));
        }
        let raw = std::fs::read_to_string(path)?;
        let mut cfg: Config = serde_yaml::from_str(&raw)?;
        if let Some(legacy) = cfg.logging.take() {
            if cfg.replays.dir == ReplaysConfig::default().dir {
                eprintln!(
                    "WARN config: секция logging.log_dir устарела — переношу в replays.dir ({:?})",
                    legacy.log_dir
                );
                cfg.replays.dir = legacy.log_dir;
            } else {
                eprintln!(
                    "WARN config: секция logging устарела и игнорируется (replays.dir={:?})",
                    cfg.replays.dir
                );
            }
        }
        Ok(cfg)
    }
}

/// `screen:` with every key commented out parses as YAML null. `#[serde(default)]`
/// only covers an absent key, so accept null explicitly and fall back to
/// autodetection instead of failing to load the config.
fn screen_or_default<'de, D>(de: D) -> Result<ScreenConfig, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<ScreenConfig>::deserialize(de)?.unwrap_or_default())
}

fn d_async() -> String { "async".into() }
fn d_logs() -> String { "logs".into() }
fn d_replays() -> String { "replays".into() }
fn d_true() -> bool { true }
fn d_keep() -> usize { 10 }
fn d_viewer() -> String { "xdg-open".into() }
fn d_5000() -> u64 { 5000 }
fn d_1() -> u64 { 1 }
fn d_1_usize() -> usize { 1 }
fn d_3() -> u64 { 3 }
fn d_30() -> u64 { 30 }
fn d_50() -> u64 { 50 }
fn d_1000() -> u64 { 1000 }
fn d_2000() -> u64 { 2000 }
fn d_15_f64() -> f64 { 15.0 }
fn d_60_f64() -> f64 { 60.0 }
