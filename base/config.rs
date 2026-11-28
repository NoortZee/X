//! Настройки модуля «save base» (серверная логика сохранения).
//!
//! Значения по умолчанию применяются при загрузке хука; во время работы их
//! можно менять командами меню (`base cells 2 right`, `base px -32 0`, …).

use serde::Deserialize;

fn d_cell_px() -> i64 {
    64
}

/// Направление сдвига. По умолчанию — влево (частая правка при подгонке базы).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

impl Default for Direction {
    fn default() -> Self {
        Direction::Left
    }
}

impl Direction {
    pub fn label(self) -> &'static str {
        match self {
            Direction::Left => "left",
            Direction::Right => "right",
            Direction::Up => "up",
            Direction::Down => "down",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "left" | "l" | "влево" => Some(Direction::Left),
            "right" | "r" | "вправо" => Some(Direction::Right),
            "up" | "u" | "вверх" => Some(Direction::Up),
            "down" | "d" | "вниз" => Some(Direction::Down),
            _ => None,
        }
    }

    /// Смещение в пикселях для заданного числа клеток.
    pub fn offset_px(self, cells: i64, cell_px: i64) -> (i64, i64) {
        let px = cells.saturating_mul(cell_px);
        match self {
            Direction::Left => (-px, 0),
            Direction::Right => (px, 0),
            Direction::Up => (0, px),
            Direction::Down => (0, -px),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct BaseConfig {
    /// Включать подмену сразу после загрузки модуля (`base` в меню всё равно нужен).
    #[serde(default)]
    pub enabled: bool,
    /// Сдвиг в клетках; 0 — не двигать. Игнорируется, если задан `pixels`.
    #[serde(default)]
    pub cells: i64,
    /// Сдвиг в пикселях: `pixels: [dx, dy]` (или `{x: dx, y: dy}`).
    #[serde(default)]
    pub pixels: Option<PixelOffset>,
    #[serde(default)]
    pub dir: Direction,
    /// Размер клетки арены в пикселях (в протоколе — 64).
    #[serde(default = "d_cell_px")]
    pub cell_px: i64,
}

impl Default for BaseConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cells: 0,
            pixels: None,
            dir: Direction::Left,
            cell_px: d_cell_px(),
        }
    }
}

/// Смещение в пикселях: поддерживаются обе формы записи в YAML.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum PixelOffset {
    Pair([i64; 2]),
    Named { x: i64, y: i64 },
}

impl PixelOffset {
    pub fn xyz(self) -> (i64, i64) {
        match self {
            PixelOffset::Pair([x, y]) => (x, y),
            PixelOffset::Named { x, y } => (x, y),
        }
    }
}

impl BaseConfig {
    /// Итоговое смещение в пикселях, которое нужно применить при загрузке.
    pub fn resolve(&self) -> (i64, i64) {
        match self.pixels {
            Some(p) => p.xyz(),
            None => self.dir.offset_px(self.cells, self.cell_px.max(1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_follow_direction() {
        let cfg = BaseConfig {
            cells: 2,
            dir: Direction::Right,
            ..Default::default()
        };
        assert_eq!(cfg.resolve(), (128, 0));

        let cfg = BaseConfig {
            cells: 1,
            dir: Direction::Down,
            ..Default::default()
        };
        assert_eq!(cfg.resolve(), (0, -64));
    }

    #[test]
    fn pixels_win_over_cells() {
        let cfg = BaseConfig {
            cells: 5,
            pixels: Some(PixelOffset::Pair([-32, 16])),
            ..Default::default()
        };
        assert_eq!(cfg.resolve(), (-32, 16));
    }

    #[test]
    fn direction_parses_ru_and_short_forms() {
        assert_eq!(Direction::parse("l"), Some(Direction::Left));
        assert_eq!(Direction::parse("ВВЕРХ"), Some(Direction::Up));
        assert_eq!(Direction::parse("nope"), None);
    }
}
