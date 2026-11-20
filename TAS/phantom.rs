//! TCP client for Phantom's binary touch protocol.
//!
//! Protocol (little-endian):
//!   TOUCH_DOWN 0x00 slot(u8) x(i32) y(i32)
//!   TOUCH_UP   0x02 slot(u8)
//!   PING       0x7f

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::thread;
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::config::PhantomConfig;

#[derive(Error, Debug)]
pub enum PhantomError {
    #[error("unsupported sync_mode={0} (use 'async')")]
    UnsupportedSyncMode(String),
    #[error("resolve failed for {0}: {1}")]
    Resolve(String, std::io::Error),
    #[error("connect failed: {0}")]
    Connect(std::io::Error),
    #[error("phantom server closed connection on ping (not listening behind adb forward?)")]
    DeadServer,
    #[error("tap failed: {0}")]
    Tap(String),
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct TapResult {
    pub ok: bool,
    pub duration_ms: f64,
    pub sync_mode: String,
    pub slot: u8,
    pub x: i32,
    pub y: i32,
    pub error: Option<String>,
}

pub struct PhantomBridge {
    host: String,
    port: u16,
    slot: u8,
    down_up_ms: u64,
    post_wait_ms: u64,
    sync_mode: String,
    connect_timeout: Duration,
    ping_timeout: Duration,
    reconnect_attempts: usize,
    stream: Option<TcpStream>,
}

impl PhantomBridge {
    pub fn new(cfg: &PhantomConfig) -> Result<Self, PhantomError> {
        if cfg.sync_mode != "async" && cfg.sync_mode != "wait_for_finish" {
            return Err(PhantomError::UnsupportedSyncMode(cfg.sync_mode.clone()));
        }
        if cfg.sync_mode == "wait_for_finish" {
            eprintln!("WARN phantom: sync_mode=wait_for_finish hangs on frozen levels and is not distinct on the wire; prefer 'async'");
        }
        Ok(Self {
            host: cfg.host.clone(),
            port: cfg.port,
            slot: cfg.slot,
            down_up_ms: cfg.tap_down_to_up_ms,
            post_wait_ms: cfg.post_tap_wait_ms,
            sync_mode: cfg.sync_mode.clone(),
            connect_timeout: Duration::from_millis(cfg.connect_timeout_ms.max(100)),
            ping_timeout: Duration::from_millis(cfg.ping_timeout_ms.max(50)),
            reconnect_attempts: cfg.reconnect_attempts,
            stream: None,
        })
    }

    pub fn connect(&mut self) -> Result<(), PhantomError> {
        if self.stream.is_some() {
            return Ok(());
        }
        let target = format!("{}:{}", self.host, self.port);
        let addrs: Vec<SocketAddr> = target
            .to_socket_addrs()
            .map_err(|e| PhantomError::Resolve(target.clone(), e))?
            .collect();
        let addr = addrs
            .into_iter()
            .next()
            .ok_or_else(|| PhantomError::Resolve(target, std::io::Error::other("no addresses")))?;

        let stream = TcpStream::connect_timeout(&addr, self.connect_timeout)
            .map_err(PhantomError::Connect)?;
        let _ = stream.set_nodelay(true);
        self.stream = Some(stream);

        if let Err(e) = self.ping() {
            self.close();
            return Err(e);
        }
        eprintln!("INFO phantom: connected to {}:{}", self.host, self.port);
        Ok(())
    }

    fn ping(&mut self) -> Result<(), PhantomError> {
        let Some(s) = self.stream.as_mut() else {
            return Err(PhantomError::DeadServer);
        };
        s.write_all(&[0x7f]).map_err(PhantomError::Connect)?;
        let _ = s.set_read_timeout(Some(self.ping_timeout));
        let mut buf = [0u8; 1];
        let res = match s.read(&mut buf) {
            // Immediate EOF (0 bytes) means adb forward accepted TCP,
            // but PhantomServer inside Android is not listening.
            Ok(0) => Err(PhantomError::DeadServer),
            Ok(_) => Ok(()),
            // Server may not echo PING byte in older builds; tolerate timeout.
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => Ok(()),
            Err(e) => Err(PhantomError::Connect(e)),
        };
        if let Some(s) = self.stream.as_mut() {
            let _ = s.set_read_timeout(None);
        }
        res
    }

    pub fn close(&mut self) {
        self.stream = None;
    }

    #[inline]
    fn encode_down(slot: u8, x: i32, y: i32) -> [u8; 10] {
        let xb = x.to_le_bytes();
        let yb = y.to_le_bytes();
        [
            0x00, slot, xb[0], xb[1], xb[2], xb[3], yb[0], yb[1], yb[2], yb[3],
        ]
    }

    #[inline]
    fn encode_up(slot: u8) -> [u8; 2] {
        [0x02, slot]
    }

    fn send_tap_once(&mut self, x: i32, y: i32) -> std::io::Result<()> {
        let down = Self::encode_down(self.slot, x, y);
        let up = Self::encode_up(self.slot);
        let s = self
            .stream
            .as_mut()
            .ok_or_else(|| std::io::Error::new(ErrorKind::NotConnected, "not connected"))?;

        if self.down_up_ms == 0 {
            let mut pkt = [0u8; 12];
            pkt[..10].copy_from_slice(&down);
            pkt[10..].copy_from_slice(&up);
            s.write_all(&pkt)?;
        } else {
            s.write_all(&down)?;
            thread::sleep(Duration::from_millis(self.down_up_ms));
            let s = self
                .stream
                .as_mut()
                .ok_or_else(|| std::io::Error::new(ErrorKind::NotConnected, "not connected"))?;
            s.write_all(&up)?;
        }

        if self.sync_mode != "wait_for_finish" && self.post_wait_ms > 0 {
            thread::sleep(Duration::from_millis(self.post_wait_ms));
        }
        Ok(())
    }

    pub fn tap(&mut self, x: i32, y: i32) -> TapResult {
        let t0 = Instant::now();
        let max_tries = 1 + self.reconnect_attempts;

        for attempt in 0..max_tries {
            if let Err(e) = self.connect() {
                return TapResult {
                    ok: false,
                    duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
                    sync_mode: self.sync_mode.clone(),
                    slot: self.slot,
                    x,
                    y,
                    error: Some(e.to_string()),
                };
            }
            match self.send_tap_once(x, y) {
                Ok(()) => {
                    return TapResult {
                        ok: true,
                        duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
                        sync_mode: self.sync_mode.clone(),
                        slot: self.slot,
                        x,
                        y,
                        error: None,
                    };
                }
                Err(e) => {
                    self.close();
                    let retryable = matches!(
                        e.kind(),
                        ErrorKind::BrokenPipe
                            | ErrorKind::ConnectionReset
                            | ErrorKind::ConnectionAborted
                            | ErrorKind::UnexpectedEof
                    );
                    if retryable && attempt + 1 < max_tries {
                        eprintln!("WARN phantom: connection broken ({e}), reconnecting");
                        continue;
                    }
                    eprintln!("ERROR phantom: tap failed: {e}");
                    return TapResult {
                        ok: false,
                        duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
                        sync_mode: self.sync_mode.clone(),
                        slot: self.slot,
                        x,
                        y,
                        error: Some(e.to_string()),
                    };
                }
            }
        }

        TapResult {
            ok: false,
            duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
            sync_mode: self.sync_mode.clone(),
            slot: self.slot,
            x,
            y,
            error: Some("tap retries exhausted".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn encodes_touch_packets_little_endian() {
        assert_eq!(
            PhantomBridge::encode_down(0, 540, 960),
            [0x00, 0x00, 0x1c, 0x02, 0x00, 0x00, 0xc0, 0x03, 0x00, 0x00]
        );
        assert_eq!(PhantomBridge::encode_up(0), [0x02, 0x00]);
    }

    #[test]
    fn detects_dead_server_on_eof_ping() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let jh = thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            drop(conn); // close immediately (simulates adb forward when server is dead)
        });
        let cfg = PhantomConfig {
            host: "127.0.0.1".into(),
            port,
            connect_timeout_ms: 500,
            ping_timeout_ms: 200,
            sync_mode: "async".into(),
            tap_down_to_up_ms: 0,
            post_tap_wait_ms: 0,
            slot: 0,
            reconnect_attempts: 0,
        };
        let mut p = PhantomBridge::new(&cfg).unwrap();
        assert!(matches!(p.connect(), Err(PhantomError::DeadServer)));
        jh.join().unwrap();
    }
}
