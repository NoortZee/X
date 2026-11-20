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
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub phantom: PhantomConfig,
    pub tap: TapConfig,
    #[serde(default)]
    pub stones: StonesConfig,
    #[serde(default)]
    pub telegram: TelegramConfig,
    pub orchestrator: OrchestratorConfig,
    pub frida: FridaConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
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

#[derive(Debug, Clone, Deserialize)]
pub struct TapConfig {
    pub position: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub screen_width: Option<i32>,
    pub screen_height: Option<i32>,
}

impl TapConfig {
    pub fn resolve(&self) -> Result<(i32, i32), ConfigError> {
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
            "center_lower_third" => {
                let w = self
                    .screen_width
                    .ok_or_else(|| ConfigError::InvalidTap("missing screen_width".into()))?;
                let h = self
                    .screen_height
                    .ok_or_else(|| ConfigError::InvalidTap("missing screen_height".into()))?;
                Ok((w / 2, (h * 2) / 3))
            }
            other => Err(ConfigError::InvalidTap(format!(
                "unknown tap.position={other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SkipCoords {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StonesConfig {
    pub skip_on_no_match: Option<SkipCoords>,
    #[serde(default = "d_80")]
    pub skip_wait_ms: u64,
    #[serde(default = "d_120", alias = "skip_delay_ms")]
    pub burst_interval_ms: u64,
    #[serde(default = "d_5000")]
    pub stall_timeout_ms: u64,
    #[serde(default = "d_500")]
    pub burst_pause_every: u64,
    #[serde(default = "d_3000")]
    pub burst_pause_ms: u64,
    #[serde(default = "d_10")]
    pub tap_fail_abort: u32,
    #[serde(default = "d_3_f64")]
    pub health_check_interval_s: f64,
    #[serde(default)]
    pub verbose_output: bool,
}

impl Default for StonesConfig {
    fn default() -> Self {
        Self {
            skip_on_no_match: None,
            skip_wait_ms: 80,
            burst_interval_ms: 120,
            stall_timeout_ms: 5000,
            burst_pause_every: 500,
            burst_pause_ms: 3000,
            tap_fail_abort: 10,
            health_check_interval_s: 3.0,
            verbose_output: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub chat_id: serde_yaml::Value,
    #[serde(default = "d_5_f64")]
    pub timeout_s: f64,
    #[serde(default = "d_10_f64")]
    pub min_interval_s: f64,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_token: String::new(),
            chat_id: serde_yaml::Value::Null,
            timeout_s: 5.0,
            min_interval_s: 10.0,
        }
    }
}

impl TelegramConfig {
    pub fn chat_id_str(&self) -> String {
        match &self.chat_id {
            serde_yaml::Value::String(s) => s.trim().to_string(),
            serde_yaml::Value::Number(n) => n.to_string(),
            _ => String::new(),
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

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingConfig {
    #[allow(dead_code)]
    #[serde(default = "d_info")]
    pub level: String,
    #[serde(default = "d_logs")]
    pub log_dir: String,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "INFO".into(),
            log_dir: "logs".into(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        if !path.exists() {
            return Err(ConfigError::NotFound(path.display().to_string()));
        }
        let raw = std::fs::read_to_string(path)?;
        Ok(serde_yaml::from_str(&raw)?)
    }
}

fn d_async() -> String { "async".into() }
fn d_info() -> String { "INFO".into() }
fn d_logs() -> String { "logs".into() }
fn d_1() -> u64 { 1 }
fn d_1_usize() -> usize { 1 }
fn d_3() -> u64 { 3 }
fn d_30() -> u64 { 30 }
fn d_50() -> u64 { 50 }
fn d_80() -> u64 { 80 }
fn d_120() -> u64 { 120 }
fn d_500() -> u64 { 500 }
fn d_1000() -> u64 { 1000 }
fn d_2000() -> u64 { 2000 }
fn d_3000() -> u64 { 3000 }
fn d_5000() -> u64 { 5000 }
fn d_10() -> u32 { 10 }
fn d_3_f64() -> f64 { 3.0 }
fn d_5_f64() -> f64 { 5.0 }
fn d_10_f64() -> f64 { 10.0 }
fn d_15_f64() -> f64 { 15.0 }
fn d_60_f64() -> f64 { 60.0 }
