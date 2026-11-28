//! Скриншот дисплея Waydroid через adb — кадр базы для шапки реплея.
//!
//! Только чтение: `adb exec-out screencap -p` ничего не пишет в игру и не
//! трогает процесс игры. Таймаут соблюдается вручную: зависший screencap
//! иначе держал бы завершение записи.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::config::ScreenshotConfig;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Вырезать PNG из потока stdout. Waydroid печатает в stdout предупреждения
/// графического стека (например
/// `/vendor/etc/hwdata/amdgpu.ids: No such file or directory`) перед картинкой,
/// поэтому сигнатура ищется, а не предполагается на нулевом байте.
fn png_from_stream(bytes: &[u8]) -> Option<&[u8]> {
    let start = bytes
        .windows(PNG_SIGNATURE.len())
        .position(|window| window == PNG_SIGNATURE)?;
    let png = &bytes[start..];
    if png.len() < 32 || !png.windows(4).any(|w| w == b"IEND") {
        return None;
    }
    Some(png)
}

/// Снять кадр. Возвращает байты PNG или текст причины, почему не вышло.
pub fn screenshot(cfg: &ScreenshotConfig) -> Result<Vec<u8>, String> {
    if !cfg.enabled {
        return Err("скриншоты выключены (replays.screenshot.enabled=false)".into());
    }
    let mut cmd = Command::new("adb");
    let device = cfg.resolved_device();
    if !device.is_empty() {
        cmd.arg("-s").arg(device);
    }
    cmd.args(["exec-out", "screencap", "-p"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("adb не запустился: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("у adb нет stdout")?;
    let mut stderr = child.stderr.take().ok_or("у adb нет stderr")?;
    let png_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });

    let limit = Duration::from_millis(cfg.timeout_ms.max(200));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("screencap не ответил за {} мс", cfg.timeout_ms));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("adb wait: {e}")),
        }
    };
    let png = png_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("adb screencap: {}", stderr.trim()));
    }
    let Some(png) = png_from_stream(&png) else {
        return Err(format!(
            "screencap вернул не PNG ({} байт): {}",
            png.len(),
            stderr.trim()
        ));
    };
    Ok(png.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_body() -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        v.extend_from_slice(&[0u8; 64]);
        v.extend_from_slice(b"IEND\xaeB`\x82");
        v
    }

    #[test]
    fn png_is_taken_from_stdout_after_tool_noise() {
        let png = png_body();
        let mut stream = b"/vendor/etc/hwdata/amdgpu.ids: No such file or directory\n".to_vec();
        stream.extend_from_slice(&png);
        let found = png_from_stream(&stream).expect("PNG после предупреждения");
        assert_eq!(found, png.as_slice());

        assert_eq!(png_from_stream(&png).map(|p| p.len()), Some(png.len()));
        assert!(png_from_stream(b"<html>no image</html>").is_none());
        assert!(png_from_stream(PNG_SIGNATURE).is_none(), "обрезанный PNG");
    }

    #[test]
    fn disabled_screenshot_reports_why() {
        let cfg = ScreenshotConfig {
            enabled: false,
            ..Default::default()
        };
        let err = screenshot(&cfg).unwrap_err();
        assert!(err.contains("выключены"), "{err}");
    }
}
