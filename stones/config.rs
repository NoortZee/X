//! Настройки сканера соперников и его Telegram-уведомлений.

use serde::Deserialize;

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

fn d_80() -> u64 { 80 }
fn d_120() -> u64 { 120 }
fn d_500() -> u64 { 500 }
fn d_3000() -> u64 { 3000 }
fn d_5000() -> u64 { 5000 }
fn d_10() -> u32 { 10 }
fn d_3_f64() -> f64 { 3.0 }
fn d_5_f64() -> f64 { 5.0 }
fn d_10_f64() -> f64 { 10.0 }
