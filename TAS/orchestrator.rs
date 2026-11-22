use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use thiserror::Error;

use crate::config::Config;
use crate::frida_agent::{AgentError, PlayState, TasAgent};
use crate::phantom::PhantomBridge;
use crate::replay::{build_plan, find_anchor, PlanStep, Replay};

pub const OVERSHOOT_TOLERANCE: i64 = 10;
pub const MISSED: i64 = -99999;

#[derive(Error, Debug)]
pub enum ReplayError {
    #[error("replay error: {0}")]
    Msg(String),
    #[error("agent error: {0}")]
    Agent(#[from] AgentError),
    #[error("aborted by user (Ctrl+C)")]
    Aborted,
}

/// Per-jump outcome: only what the report and the console line actually read.
#[derive(Debug, Clone)]
pub struct FireRecord {
    pub frame_error: i64,
    pub tap_ack_ms: f64,
    pub tap_count: u32,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct FrameErrorStats {
    pub min: Option<i64>,
    pub med: Option<f64>,
    pub max: Option<i64>,
    pub abs_med: Option<f64>,
    pub abs_max: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct TapStatsMs {
    pub min: f64,
    pub med: f64,
    pub max: f64,
}

#[derive(Debug, Clone)]
pub struct PlayReport {
    pub jumps_planned: usize,
    pub jumps_fired: usize,
    pub jumps_missed: usize,
    pub covered_by_user_tap: usize,
    pub retries: usize,
    pub wall_limit_s: Option<f64>,
    pub frame_error_stats: FrameErrorStats,
    pub tap_stats_ms: TapStatsMs,
    pub verify_body_frames: Value,
    pub elapsed_s: f64,
}

pub fn effective_wall_timeout(configured_raw: Option<f64>, nominal_fps: f64, plan: &[PlanStep]) -> Option<f64> {
    let configured = configured_raw?;
    if !configured.is_finite() || configured <= 0.0 {
        return None;
    }
    if plan.is_empty() || nominal_fps <= 0.0 {
        return Some(configured);
    }
    let last_delta = plan.last().map(|s| s.frame_delta.max(0)).unwrap_or(0) as f64;
    let est = last_delta / nominal_fps;
    let adaptive = est * 1.5 + 60.0;
    let effective = configured.max(adaptive);
    if effective > configured {
        eprintln!(
            "WARN orch: wall_timeout_s={configured:.0}s < plan duration est {est:.0}s (last delta={last_delta:.0} @ {nominal_fps:.0} fps) — auto-raising to {effective:.0}s"
        );
    }
    Some(effective)
}

fn median_i64(vals: &[i64]) -> Option<f64> {
    if vals.is_empty() {
        return None;
    }
    let mut s = vals.to_vec();
    s.sort_unstable();
    let mid = s.len() / 2;
    if s.len() % 2 == 1 {
        Some(s[mid] as f64)
    } else {
        Some((s[mid - 1] + s[mid]) as f64 / 2.0)
    }
}

fn median_f64(vals: &[f64]) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut s = vals.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let mid = s.len() / 2;
    if s.len() % 2 == 1 {
        s[mid]
    } else {
        (s[mid - 1] + s[mid]) / 2.0
    }
}

pub struct Orchestrator<'c> {
    cfg: &'c Config,
    replay: &'c Replay,
    tap_x: i32,
    tap_y: i32,
    jc_baseline: Option<u64>,
}

impl<'c> Orchestrator<'c> {
    pub fn new(cfg: &'c Config, replay: &'c Replay) -> Result<Self, ReplayError> {
        let (tap_x, tap_y) = cfg
            .tap
            .resolve()
            .map_err(|e| ReplayError::Msg(e.to_string()))?;
        Ok(Self {
            cfg,
            replay,
            tap_x,
            tap_y,
            jc_baseline: None,
        })
    }

    pub fn run(
        &mut self,
        agent: &mut TasAgent<'_>,
        phantom: &mut PhantomBridge,
        aborted: &AtomicBool,
    ) -> Result<PlayReport, ReplayError> {
        let (anchor_kind, anchor_rec) = find_anchor(&self.replay.events, &self.replay.body_frames)
            .ok_or_else(|| ReplayError::Msg("no anchor".into()))?;
        let plan = build_plan(&self.replay.events, anchor_rec);
        if plan.is_empty() {
            return Err(ReplayError::Msg("no jumps".into()));
        }

        let verify_body = self.cfg.orchestrator.verify_body_frames
            && !self.replay.body_frames.is_empty();
        let setup = agent.play_setup(&self.replay.events, &self.replay.body_frames, verify_body)?;
        if setup.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(ReplayError::Msg(format!("playSetup failed: {setup}")));
        }

        // Guarantee play_stop() runs regardless of Ok / Err / Ctrl+C
        let res = self.run_inner(agent, phantom, aborted, &anchor_kind, anchor_rec, &plan, verify_body);
        if let Err(e) = agent.play_stop() {
            eprintln!("WARN orch: play_stop cleanup failed: {e}");
        }
        res
    }

    #[allow(clippy::too_many_arguments)]
    fn run_inner(
        &mut self,
        agent: &mut TasAgent<'_>,
        phantom: &mut PhantomBridge,
        aborted: &AtomicBool,
        anchor_kind: &str,
        anchor_rec: i64,
        plan: &[PlanStep],
        verify_body: bool,
    ) -> Result<PlayReport, ReplayError> {
        if let Err(e) = phantom.connect() {
            eprintln!("WARN orch: phantom pre-connect failed: {e}");
        } else {
            eprintln!("INFO orch: phantom pre-connected");
        }

        self.jc_baseline = match agent.pump_jump_count() {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("WARN orch: pump_jump_count baseline failed: {e}");
                None
            }
        };

        let o = &self.cfg.orchestrator;
        let wall_limit_s = effective_wall_timeout(o.wall_timeout_s, o.nominal_fps, plan);
        eprintln!(
            "INFO orch: playSetup: anchor={}@{} jumps={} lead={:.0}ms check={}ms retry={} overshoot_tol={} jc_baseline={:?} wall_limit_s={}",
            anchor_kind,
            anchor_rec,
            plan.len(),
            o.predict_lead_ms,
            o.post_tap_check_ms,
            o.retry_on_miss,
            OVERSHOOT_TOLERANCE,
            self.jc_baseline,
            wall_limit_s
                .map(|v| format!("{v:.0}"))
                .unwrap_or_else(|| "none".into())
        );
        eprintln!("INFO orch: tap position: ({}, {})", self.tap_x, self.tap_y);

        let initial_state = self.wait_playing(agent, aborted)?;
        let wall0 = Instant::now();
        let mut fire_log = Vec::with_capacity(plan.len());

        for (i, step) in plan.iter().enumerate() {
            if aborted.load(Ordering::SeqCst) {
                return Err(ReplayError::Aborted);
            }
            if let Some(limit) = wall_limit_s {
                if wall0.elapsed().as_secs_f64() > limit {
                    return Err(ReplayError::Msg(format!(
                        "wall_timeout (fired={}/{}, limit={limit:.0}s)",
                        fire_log.len(),
                        plan.len()
                    )));
                }
            }
            let fr = self.fire_async(
                agent,
                phantom,
                aborted,
                step,
                if i == 0 { Some(&initial_state) } else { None },
            )?;
            fire_log.push(fr);
        }

        let verify_bf = if verify_body {
            agent.play_verify().unwrap_or_else(|e| {
                eprintln!("WARN orch: play_verify: {e}");
                Value::Null
            })
        } else {
            json!({})
        };

        let durations: Vec<f64> = if fire_log.is_empty() {
            vec![0.0]
        } else {
            fire_log.iter().map(|fr| fr.tap_ack_ms).collect()
        };
        let errors: Vec<i64> = fire_log
            .iter()
            .filter(|fr| fr.frame_error != MISSED)
            .map(|fr| fr.frame_error)
            .collect();
        let abs_errors: Vec<i64> = errors.iter().map(|e| e.abs()).collect();

        Ok(PlayReport {
            jumps_planned: plan.len(),
            jumps_fired: fire_log.iter().filter(|fr| fr.frame_error != MISSED).count(),
            jumps_missed: fire_log.iter().filter(|fr| fr.frame_error == MISSED).count(),
            covered_by_user_tap: fire_log
                .iter()
                .filter(|fr| fr.note == "covered_by_user_tap")
                .count(),
            retries: fire_log.iter().filter(|fr| fr.tap_count > 1).count(),
            wall_limit_s,
            frame_error_stats: FrameErrorStats {
                min: errors.iter().copied().min(),
                med: median_i64(&errors),
                max: errors.iter().copied().max(),
                abs_med: median_i64(&abs_errors),
                abs_max: abs_errors.iter().copied().max(),
            },
            tap_stats_ms: TapStatsMs {
                min: durations.iter().copied().fold(f64::INFINITY, f64::min),
                med: median_f64(&durations),
                max: durations.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            },
            verify_body_frames: verify_bf,
            elapsed_s: wall0.elapsed().as_secs_f64(),
        })
    }

    fn wait_playing(
        &self,
        agent: &mut TasAgent<'_>,
        aborted: &AtomicBool,
    ) -> Result<PlayState, ReplayError> {
        let o = &self.cfg.orchestrator;
        let t0 = Instant::now();
        let wait_limit = o
            .wall_timeout_s
            .filter(|v| v.is_finite() && *v > 0.0);
        let poll_dur = Duration::from_millis(o.poll_interval_ms.max(1));

        loop {
            if aborted.load(Ordering::SeqCst) {
                return Err(ReplayError::Aborted);
            }
            let st = agent.play_state()?;
            match st.phase.as_str() {
                "playing" => return Ok(st),
                "idle" => return Err(ReplayError::Msg("play setup not initialised".into())),
                other => {
                    if let Some(lim) = wait_limit {
                        if t0.elapsed().as_secs_f64() > lim {
                            return Err(ReplayError::Msg(format!("wall_timeout (phase={other})")));
                        }
                    }
                    thread::sleep(poll_dur);
                }
            }
        }
    }

    fn snap_at_frame(agent: &mut TasAgent<'_>, frame: i64) -> Value {
        let Ok(tail) = agent.ring_tail(4) else {
            return json!({});
        };
        for r in tail {
            if r.get("frame").and_then(|v| v.as_i64()) == Some(frame) {
                let mut map = serde_json::Map::new();
                for k in ["a0", "b0", "g80", "g84", "px", "py", "vx", "vy"] {
                    if let Some(v) = r.get(k) {
                        map.insert(k.to_string(), v.clone());
                    }
                }
                return Value::Object(map);
            }
        }
        json!({})
    }

    fn try_covered_by_user_tap(
        &self,
        agent: &mut TasAgent<'_>,
        jump: &PlanStep,
        target_frame: i64,
    ) -> Option<FireRecord> {
        let baseline = self.jc_baseline?;
        let early = match agent.pump_jump_log_since(baseline) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("WARN orch: pump_jump_log_since(jc_baseline) failed: {e}");
                return None;
            }
        };
        for ej in early {
            if (ej.frame - target_frame).abs() <= 5 {
                eprintln!(
                    "INFO orch: fired idx={} fired@{} target={} err={:+} note=covered_by_user_tap (jc_baseline={})",
                    jump.idx,
                    ej.frame,
                    target_frame,
                    ej.frame - target_frame,
                    baseline
                );
                return Some(FireRecord {
                    frame_error: ej.frame - target_frame,
                    tap_ack_ms: 0.0,
                    tap_count: 0,
                    note: "covered_by_user_tap".into(),
                });
            }
        }
        None
    }

    fn fire_async(
        &self,
        agent: &mut TasAgent<'_>,
        phantom: &mut PhantomBridge,
        aborted: &AtomicBool,
        jump: &PlanStep,
        initial_state: Option<&PlayState>,
    ) -> Result<FireRecord, ReplayError> {
        let o = &self.cfg.orchestrator;
        let fps = o.nominal_fps.max(1.0);
        let trigger_at_ms = o.predict_lead_ms + o.predict_margin_ms;
        let poll_dur = Duration::from_millis(o.poll_interval_ms.max(1));
        let stall_dur = Duration::from_secs(2);

        if jump.idx == 0 {
            if let Some(st0) = initial_state {
                if let Some(anchor) = st0.anchor {
                    let target_est = anchor + jump.frame_delta;
                    if let Some(rec) = self.try_covered_by_user_tap(agent, jump, target_est) {
                        return Ok(rec);
                    }
                }
            }
        }

        let t_start = Instant::now();
        let mut last_cur: i64 = -1;
        let mut last_cur_t = t_start;
        let mut first_iter = true;
        let mut overshoot: i64 = 0;

        let (cur_before, target_frame) = loop {
            if aborted.load(Ordering::SeqCst) {
                return Err(ReplayError::Aborted);
            }
            let st = if first_iter {
                first_iter = false;
                if let Some(s) = initial_state {
                    s.clone()
                } else {
                    agent.play_state()?
                }
            } else {
                agent.play_state()?
            };

            if st.phase != "playing" {
                return Err(ReplayError::Msg(format!(
                    "fire idx={}: phase={}",
                    jump.idx, st.phase
                )));
            }
            let anchor = st
                .anchor
                .ok_or_else(|| ReplayError::Msg("missing anchor in playing state".into()))?;
            let target_frame = anchor + jump.frame_delta;
            let cur = st.frame.unwrap_or(0);

            let now = Instant::now();
            if cur != last_cur {
                last_cur = cur;
                last_cur_t = now;
            } else if now.duration_since(last_cur_t) > stall_dur {
                eprintln!(
                    "WARN orch: fire idx={} GAME STALLED cur={} target={}",
                    jump.idx, cur, target_frame
                );
                return Ok(FireRecord {
                    frame_error: MISSED,
                    tap_ack_ms: 0.0,
                    tap_count: 0,
                    note: "game_stalled".into(),
                });
            }

            let frames_to_go = target_frame - cur;
            if frames_to_go < 0 {
                overshoot = -frames_to_go;
                if overshoot <= OVERSHOOT_TOLERANCE {
                    if let Some(rec) = self.try_covered_by_user_tap(agent, jump, target_frame) {
                        return Ok(rec);
                    }
                    eprintln!(
                        "INFO orch: fire idx={} cur={} target={} overshoot={} <={} — tapping anyway",
                        jump.idx, cur, target_frame, overshoot, OVERSHOOT_TOLERANCE
                    );
                    break (cur, target_frame);
                }
                eprintln!(
                    "WARN orch: fire idx={} SKIP (cur={} target={} overshoot={} >{})",
                    jump.idx, cur, target_frame, overshoot, OVERSHOOT_TOLERANCE
                );
                return Ok(FireRecord {
                    frame_error: MISSED,
                    tap_ack_ms: 0.0,
                    tap_count: 0,
                    note: "skipped_past_target".into(),
                });
            }

            let ttm_ms = (frames_to_go as f64) * 1000.0 / fps;
            if ttm_ms <= trigger_at_ms {
                break (cur, target_frame);
            }

            thread::sleep(poll_dur);

            if t_start.elapsed().as_secs_f64() > o.fire_hard_deadline_s {
                eprintln!(
                    "WARN orch: fire idx={} SKIP deadline (cur={} target={})",
                    jump.idx, cur, target_frame
                );
                return Ok(FireRecord {
                    frame_error: MISSED,
                    tap_ack_ms: 0.0,
                    tap_count: 0,
                    note: "deadline_skipped".into(),
                });
            }
        };

        // Re-check user tap coverage for idx=0 right before tapping,
        // without using jc_baseline for our own tap's verification!
        if jump.idx == 0 {
            if let Some(rec) = self.try_covered_by_user_tap(agent, jump, target_frame) {
                return Ok(rec);
            }
        }

        let pre_state = agent
            .ring_tail(1)
            .ok()
            .and_then(|v| v.into_iter().last())
            .unwrap_or_else(|| json!({}));

        eprintln!(
            "INFO orch: fire idx={} cur={} target={} frames_to_go={} overshoot={} lead={:.0} tap=({},{}) pre_state(a0={} g80={})",
            jump.idx,
            cur_before,
            target_frame,
            target_frame - cur_before,
            overshoot,
            o.predict_lead_ms,
            self.tap_x,
            self.tap_y,
            pre_state.get("a0").map(|v| v.to_string()).unwrap_or_else(|| "None".into()),
            pre_state.get("g80").map(|v| v.to_string()).unwrap_or_else(|| "None".into()),
        );

        // Always take fresh jump count right before tapping so earlier stray jumps
        // cannot produce false-positive verification.
        let jc_before = agent.pump_jump_count()?;
        let mut total_taps: u32 = 0;
        let mut total_tap_ms: f64 = 0.0;
        let mut new_jumps = Vec::new();
        let max_attempts = if o.retry_on_miss { 2 } else { 1 };

        for attempt in 1..=max_attempts {
            if attempt > 1 {
                // Check again before sending retry tap in case attempt 1 arrived late
                new_jumps = agent.pump_jump_log_since(jc_before)?;
                if !new_jumps.is_empty() {
                    break;
                }
            }
            let tr = phantom.tap(self.tap_x, self.tap_y);
            if !tr.ok {
                return Err(ReplayError::Msg(format!(
                    "phantom tap failed: {}",
                    tr.error.unwrap_or_default()
                )));
            }
            total_taps += 1;
            total_tap_ms += tr.duration_ms;

            thread::sleep(Duration::from_millis(o.post_tap_check_ms));
            new_jumps = agent.pump_jump_log_since(jc_before)?;
            if !new_jumps.is_empty() {
                break;
            }
            if attempt < max_attempts {
                eprintln!(
                    "WARN orch: fired idx={} attempt={} no jumpFn, retry in {}ms",
                    jump.idx, attempt, o.retry_delay_ms
                );
                thread::sleep(Duration::from_millis(o.retry_delay_ms));
            }
        }

        if new_jumps.is_empty() {
            eprintln!(
                "WARN orch: fired idx={} MISSED target={} taps={} tap_ms={:.2}",
                jump.idx, target_frame, total_taps, total_tap_ms
            );
            return Ok(FireRecord {
                frame_error: MISSED,
                tap_ack_ms: total_tap_ms,
                tap_count: total_taps,
                note: "missed_no_jumpfn".into(),
            });
        }

        if new_jumps.len() > 1 {
            let frames: Vec<i64> = new_jumps.iter().map(|j| j.frame).collect();
            eprintln!(
                "WARN orch: fired idx={} MULTI-JUMP count={} frames={:?}",
                jump.idx,
                new_jumps.len(),
                frames
            );
        }

        let fired_frame = new_jumps
            .iter()
            .map(|j| j.frame)
            .min_by_key(|f| (*f - target_frame).abs())
            .unwrap();
        let frame_error = fired_frame - target_frame;
        let mut snap_after = Self::snap_at_frame(agent, fired_frame + 1);
        if snap_after.as_object().map(|m| m.is_empty()).unwrap_or(true) {
            snap_after = Self::snap_at_frame(agent, fired_frame);
        }

        eprintln!(
            "INFO orch: fired idx={} fired@{} target={} err={:+} tap={:.2}ms taps={} snap_after(a0={} g80={})",
            jump.idx,
            fired_frame,
            target_frame,
            frame_error,
            total_tap_ms,
            total_taps,
            snap_after.get("a0").map(|v| v.to_string()).unwrap_or_else(|| "None".into()),
            snap_after.get("g80").map(|v| v.to_string()).unwrap_or_else(|| "None".into()),
        );

        Ok(FireRecord {
            frame_error,
            tap_ack_ms: total_tap_ms,
            tap_count: total_taps,
            note: "async_no_gate".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_wall_timeout_scales_for_long_plans() {
        let plan = vec![PlanStep {
            idx: 0,
            rec_frame: 36000,
            frame_delta: 36000, // 600s @ 60fps
        }];
        let eff = effective_wall_timeout(Some(300.0), 60.0, &plan).unwrap();
        assert!((eff - 960.0).abs() < 1e-6);
        assert!(effective_wall_timeout(Some(0.0), 60.0, &plan).is_none());
        assert!(effective_wall_timeout(None, 60.0, &plan).is_none());
    }
}
