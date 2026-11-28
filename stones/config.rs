//! Настройки сканера соперников и его Telegram-уведомлений.

use crate::config::{scale_frac, ConfigError, ScreenConfig};

use serde::Deserialize;

/// «Найти следующего» в Find a Match.
///
/// Доли (`x_frac`/`y_frac`) масштабируются под реальное окно Waydroid, поэтому
/// кнопка остаётся на месте при любом разрешении. Абсолютные `x`/`y` имеют
/// приоритет, если заданы оба варианта.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SkipCoords {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub x_frac: Option<f64>,
    pub y_frac: Option<f64>,
}

impl SkipCoords {
    pub fn resolve(&self, screen: &ScreenConfig) -> Result<(i32, i32), ConfigError> {
        let frac = self.x_frac.is_some() || self.y_frac.is_some();
        if !frac {
            let x = self
                .x
                .ok_or_else(|| ConfigError::InvalidTap("missing stones.skip_on_no_match.x".into()))?;
            let y = self
                .y
                .ok_or_else(|| ConfigError::InvalidTap("missing stones.skip_on_no_match.y".into()))?;
            return Ok((x, y));
        }
        let (w, h) = screen.resolve()?;
        let x = match self.x {
            Some(v) => v,
            None => scale_frac(self.x_frac, w, "stones.skip_on_no_match.x_frac")?,
        };
        let y = match self.y {
            Some(v) => v,
            None => scale_frac(self.y_frac, h, "stones.skip_on_no_match.y_frac")?,
        };
        Ok((x, y))
    }
}

/// Как запрашивать следующего соперника.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkipVia {
    /// Вызвать игровой сборщик Request_MatchMaking через frida: быстро, но экран
    /// не обновляется (клиент обновит его при повторном входе в базу).
    Agent,
    /// Тап по кнопке next через phantom (старое поведение).
    Tap,
}

impl Default for SkipVia {
    /// По умолчанию тап: только он обновляет экран (обработчик панели
    /// пересоздаётся, подставить его повторно нельзя — падает клиент).
    fn default() -> Self {
        SkipVia::Tap
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct StonesConfig {
    /// Чем скипать: `agent` (по умолчанию, игровой вызов) или `tap`.
    #[serde(default)]
    pub skip_via: SkipVia,
    pub skip_on_no_match: Option<SkipCoords>,
    #[serde(default = "d_5000")]
    pub stall_timeout_ms: u64,
    #[serde(default = "d_10")]
    pub tap_fail_abort: u32,
    /// Останавливать тапы, если игра начала заход в базу (тап улетел в дверь).
    #[serde(default = "d_true")]
    pub abort_on_attack: bool,
    /// agent-режим: на MATCH обновить экран — окно принудительного flag=0 плюс
    /// один тап next. Клиент сам запросит ТЕКУЩЕГО соперника (flag=0 не листает),
    /// поэтому матч не теряется.
    #[serde(default = "d_true")]
    pub sync_ui_on_match: bool,
    /// Длительность окна принудительного flag=0, мс.
    #[serde(default = "d_3000")]
    pub sync_window_ms: u64,
    /// Завершать LIVE после MATCH и возвращаться в меню.
    #[serde(default = "d_true")]
    pub exit_after_match: bool,
    /// Задержка перед выходом: клиент должен успеть получить ответ и обновить
    /// экран (окно flag=0 ещё активно), иначе тап не перехватится.
    #[serde(default = "d_2500")]
    pub exit_delay_ms: u64,
    #[serde(default = "d_3_f64")]
    pub health_check_interval_s: f64,
    #[serde(default)]
    pub verbose_output: bool,
}

impl Default for StonesConfig {
    fn default() -> Self {
        Self {
            skip_via: SkipVia::default(),
            skip_on_no_match: None,
            stall_timeout_ms: 5000,
            tap_fail_abort: 10,
            abort_on_attack: true,
            sync_ui_on_match: true,
            sync_window_ms: 3000,
            exit_after_match: true,
            exit_delay_ms: 2500,
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

fn d_5000() -> u64 { 5000 }
fn d_3000() -> u64 { 3000 }
fn d_2500() -> u64 { 2500 }
fn d_10() -> u32 { 10 }
fn d_true() -> bool { true }
fn d_3_f64() -> f64 { 3.0 }
fn d_5_f64() -> f64 { 5.0 }
fn d_10_f64() -> f64 { 10.0 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_event_driven() {
        let cfg = StonesConfig::default();
        assert!(cfg.abort_on_attack, "по умолчанию не долбим дверь");
        assert!(cfg.stall_timeout_ms >= 500, "watchdog должен быть не меньше 0.5 c");
        assert!(cfg.tap_fail_abort >= 1);
        assert_eq!(cfg.skip_via, SkipVia::Tap, "по умолчанию тап: он обновляет UI");
        assert!(cfg.sync_ui_on_match, "на MATCH экран синхронизируем через flag=0");
        assert!(cfg.sync_window_ms >= 200, "окно flag=0 должно быть не меньше 200 мс");
        assert!(cfg.exit_after_match, "после MATCH модуль завершается сам");
        assert!(cfg.exit_delay_ms >= 200, "задержка выхода должна дать клиенту обновиться");
    }
}
