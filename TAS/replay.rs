use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ReplayIoError {
    #[error("failed to write replay: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to serialize replay: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayEvent {
    pub frame: i64,
    pub name: String,
    #[serde(default = "empty_obj")]
    pub snap: Value,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn empty_obj() -> Value {
    Value::Object(Default::default())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Replay {
    #[serde(default = "d_ver")]
    pub version: u32,
    pub anchor_frame: Option<i64>,
    pub anchor_kind: Option<String>,
    #[serde(default)]
    pub events: Vec<ReplayEvent>,
    #[serde(default)]
    pub body_frames: Vec<Value>,
    #[serde(default)]
    pub timeline_ns: Vec<Value>,
    pub rng_log: Option<Vec<Value>>,

    #[serde(skip)]
    pub recovered: bool,
    #[serde(skip)]
    pub recovered_jumps: usize,
    #[serde(skip)]
    pub recovered_delta_mode: bool,
}

fn d_ver() -> u32 {
    3
}

#[derive(Debug, Clone)]
pub struct PlanStep {
    pub idx: usize,
    pub rec_frame: i64,
    pub frame_delta: i64,
    pub snap: Value,
}

pub fn find_anchor(events: &[ReplayEvent], body_frames: &[Value]) -> Option<(String, i64)> {
    for e in events {
        if e.name == "first_hero_update" {
            return Some(("first_hero_update".into(), e.frame));
        }
    }
    if let Some(first) = body_frames.first() {
        if let Some(f) = first.get("frame").and_then(|v| v.as_i64()) {
            return Some(("first_body_frame".into(), f));
        }
    }
    for e in events {
        if e.name == "unfreeze" || e.name == "unfreeze_attack" {
            return Some(("unfreeze".into(), e.frame));
        }
    }
    None
}

pub fn build_plan(events: &[ReplayEvent], anchor_rec_frame: i64) -> Vec<PlanStep> {
    let mut jumps: Vec<&ReplayEvent> = events.iter().filter(|e| e.name == "jump").collect();
    jumps.sort_by_key(|e| e.frame);
    jumps
        .into_iter()
        .enumerate()
        .map(|(idx, j)| PlanStep {
            idx,
            rec_frame: j.frame,
            frame_delta: (j.frame - anchor_rec_frame).max(0),
            snap: if j.snap.is_null() {
                empty_obj()
            } else {
                j.snap.clone()
            },
        })
        .collect()
}

// ------------------------------------------------------------
// Comment-header parser (`""" ... """` with delta & loop N { ... })
// ------------------------------------------------------------
#[derive(Debug, Clone)]
enum Op {
    Num(i64),
    Loop(usize, Vec<Op>),
}

fn strip_line_comment(s: &str) -> &str {
    match s.find("//") {
        Some(idx) => s[..idx].trim(),
        None => s.trim(),
    }
}

fn parse_header_kv(s: &str) -> Option<(&str, &str)> {
    let (k, v) = s.split_once(':')?;
    let k = k.trim();
    if matches!(
        k,
        "jumps" | "anchor" | "fps" | "tap_down_ms" | "delta" | "mode"
    ) {
        Some((k, v.trim()))
    } else {
        None
    }
}

fn parse_loop_open(s: &str) -> Option<usize> {
    let rest = s.strip_prefix("loop")?.trim_start();
    let num_part = rest.strip_suffix('{')?.trim();
    if num_part.is_empty() || !num_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    num_part.parse().ok()
}

fn is_loop_close(s: &str) -> bool {
    let t = s.strip_suffix(',').unwrap_or(s).trim();
    t == "}"
}

fn parse_frame_value(s: &str) -> Option<i64> {
    let t = s.strip_suffix(',').unwrap_or(s).trim();
    if let Ok(n) = t.parse::<i64>() {
        return Some(n);
    }
    if t.starts_with('{') && t.ends_with('}') {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(t) {
            if map.len() == 1 {
                if let Some(f) = map.get("frame").and_then(|v| v.as_i64()) {
                    return Some(f);
                }
            }
        }
    }
    None
}

fn exec_ops(ops: &[Op], mut cursor: i64, out: &mut Vec<i64>) -> i64 {
    for op in ops {
        match op {
            Op::Num(d) => {
                cursor += *d;
                out.push(cursor);
            }
            Op::Loop(count, body) => {
                for _ in 0..*count {
                    cursor = exec_ops(body, cursor, out);
                }
            }
        }
    }
    cursor
}

fn flatten_abs(ops: &[Op], out: &mut Vec<i64>) {
    for op in ops {
        match op {
            Op::Num(v) => out.push(*v),
            Op::Loop(_, body) => flatten_abs(body, out),
        }
    }
}

fn contains_loop(ops: &[Op]) -> bool {
    ops.iter().any(|op| matches!(op, Op::Loop(_, _)))
}

// The editable frame script ends at its closing delimiter, never at JSON EOF.
// Legacy delimiter-free scripts are supported, but must stop before a JSON body.
fn frame_script_text(text: &str) -> &str {
    let mut start = 0;
    let mut offset = 0;
    let mut opened = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim().trim_start_matches('\u{feff}');
        if trimmed == "\"\"\"" {
            if opened {
                return &text[start..offset];
            }
            opened = true;
            start = offset + line.len();
        } else if trimmed.starts_with('{') && parse_frame_value(trimmed).is_none() {
            return &text[start..offset];
        }
        offset += line.len();
    }
    &text[start..]
}

fn parse_header_map(text: &str) -> HashMap<String, String> {
    let mut header = HashMap::new();
    for raw in frame_script_text(text).lines() {
        let s = strip_line_comment(raw);
        if s.is_empty() || s.starts_with("\"\"\"") {
            continue;
        }
        if let Some((k, v)) = parse_header_kv(s) {
            header.insert(k.to_string(), v.to_string());
        }
    }
    header
}

fn recover_from_header_frames(text: &str) -> Option<Replay> {
    let mut header: HashMap<String, String> = HashMap::new();
    let mut root: Vec<Op> = Vec::new();
    let mut active_loops: Vec<(usize, Vec<Op>)> = Vec::new();

    for raw in frame_script_text(text).lines() {
        let s = strip_line_comment(raw);
        if s.is_empty() {
            continue;
        }
        if let Some((k, v)) = parse_header_kv(s) {
            header.insert(k.to_string(), v.to_string());
            continue;
        }
        if let Some(count) = parse_loop_open(s) {
            active_loops.push((count, Vec::new()));
            continue;
        }
        if is_loop_close(s) {
            if let Some((count, body)) = active_loops.pop() {
                let op = Op::Loop(count, body);
                match active_loops.last_mut() {
                    Some((_, parent)) => parent.push(op),
                    None => root.push(op),
                }
            } else {
                eprintln!("WARN replay: unbalanced '}}' in replay.json — ignored");
            }
            continue;
        }
        if let Some(v) = parse_frame_value(s) {
            let op = Op::Num(v);
            match active_loops.last_mut() {
                Some((_, body)) => body.push(op),
                None => root.push(op),
            }
        }
    }

    if !active_loops.is_empty() {
        eprintln!("WARN replay: unclosed loop in replay.json — treating as closed at EOF");
        while let Some((count, body)) = active_loops.pop() {
            let op = Op::Loop(count, body);
            match active_loops.last_mut() {
                Some((_, parent)) => parent.push(op),
                None => root.push(op),
            }
        }
    }

    let (anchor_kind, anchor_frame) = match header.get("anchor") {
        Some(a) if a.contains('@') => {
            let (kind_part, frame_part) = a.split_once('@').unwrap();
            let kind = {
                let t = kind_part.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            };
            let frame = frame_part.trim().parse::<i64>().ok();
            (kind, frame)
        }
        _ => (None, None),
    };

    let mut is_delta = header
        .get("delta")
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    if is_delta && anchor_frame.is_none() {
        eprintln!("WARN replay: delta: true but no valid anchor — treating as absolute");
        is_delta = false;
    }

    let mut abs_frames = Vec::new();
    if is_delta {
        exec_ops(&root, anchor_frame.unwrap(), &mut abs_frames);
    } else {
        if contains_loop(&root) {
            eprintln!("WARN replay: loop {{ ... }} requires 'delta: true' — expanding once");
        }
        flatten_abs(&root, &mut abs_frames);
    }

    if abs_frames.is_empty() {
        return None;
    }

    if let Some(Ok(declared)) = header.get("jumps").map(|s| s.parse::<usize>()) {
        if declared != abs_frames.len() {
            eprintln!(
                "WARN replay: 'jumps: {}' declared but {} frame values after expansion",
                declared,
                abs_frames.len()
            );
        }
    }

    let kind = anchor_kind.unwrap_or_else(|| "first_hero_update".into());
    let mut events = Vec::with_capacity(abs_frames.len() + 1);
    if let Some(af) = anchor_frame {
        events.push(ReplayEvent {
            frame: af,
            name: kind.clone(),
            snap: empty_obj(),
            extra: BTreeMap::new(),
        });
    }
    for f in &abs_frames {
        events.push(ReplayEvent {
            frame: *f,
            name: "jump".into(),
            snap: empty_obj(),
            extra: BTreeMap::new(),
        });
    }

    Some(Replay {
        version: 3,
        anchor_frame,
        anchor_kind: Some(kind),
        events,
        body_frames: Vec::new(),
        timeline_ns: Vec::new(),
        rng_log: None,
        recovered: true,
        recovered_jumps: abs_frames.len(),
        recovered_delta_mode: is_delta,
    })
}

fn extract_json_body(text: &str) -> Option<Replay> {
    // Only scan for JSON objects starting after the comment block or containing `"version":`
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find('{') {
        let start = search_from + rel;
        let slice = text[start..].trim();
        let head: String = slice.chars().take(64).collect();
        if head.contains("\"version\"") {
            if let Ok(r) = serde_json::from_str::<Replay>(slice) {
                return Some(r);
            }
            if let Some(last_brace) = slice.rfind('}') {
                if let Ok(r) = serde_json::from_str::<Replay>(&slice[..=last_brace]) {
                    return Some(r);
                }
            }
        }
        search_from = start + 1;
    }
    None
}

pub fn load_replay(path: &Path) -> Replay {
    if !path.exists() {
        return Replay::default();
    }
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("ERROR replay: failed to read {}: {e}", path.display());
            return Replay::default();
        }
    };

    let header = parse_header_map(&text);
    let mode = header
        .get("mode")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let force_comment = matches!(mode.as_str(), "comment" | "frames_only" | "frames");

    let body = extract_json_body(&text);
    let recovered = recover_from_header_frames(&text);

    if force_comment {
        if let Some(r) = recovered {
            eprintln!("INFO replay: mode=comment -> using frame list from comment");
            return r;
        }
        if let Some(b) = body {
            eprintln!("WARN replay: mode=comment but no frame list -> fallback to JSON body");
            return b;
        }
        return Replay::default();
    }

    match (body, recovered) {
        (Some(b), Some(r)) => {
            let mut body_jumps: Vec<i64> = b
                .events
                .iter()
                .filter(|e| e.name == "jump")
                .map(|e| e.frame)
                .collect();
            body_jumps.sort_unstable();

            let mut cmt_jumps: Vec<i64> = r
                .events
                .iter()
                .filter(|e| e.name == "jump")
                .map(|e| e.frame)
                .collect();
            cmt_jumps.sort_unstable();

            if body_jumps != cmt_jumps {
                eprintln!(
                    "WARN replay: comment diverges from JSON body ({} vs {} jumps) — using comment; body_frames disabled",
                    cmt_jumps.len(),
                    body_jumps.len()
                );
                r
            } else {
                b
            }
        }
        (Some(b), None) => b,
        (None, Some(r)) => {
            eprintln!(
                "WARN replay: no JSON body; recovered {} jumps (delta={})",
                r.recovered_jumps, r.recovered_delta_mode
            );
            r
        }
        (None, None) => {
            eprintln!("ERROR replay: replay.json is empty or unparsable");
            Replay::default()
        }
    }
}

// ------------------------------------------------------------
// Comment generation with auto-loop compression
// ------------------------------------------------------------
pub fn emit_delta_lines(deltas: &[i64]) -> Vec<String> {
    let n = deltas.len();
    let mut lines = Vec::new();
    let mut i = 0;
    while i < n {
        let max_plen = 6.min((n - i) / 2);
        let mut best_pat: Option<&[i64]> = None;
        let mut best_len = 0usize;
        let mut best_reps = 0usize;

        for plen in 1..=max_plen {
            let pat = &deltas[i..i + plen];
            let mut reps = 1usize;
            let mut j = i + plen;
            while j + plen <= n && &deltas[j..j + plen] == pat {
                reps += 1;
                j += plen;
            }
            if reps >= 2 && reps * plen > best_reps * best_len {
                best_pat = Some(pat);
                best_len = plen;
                best_reps = reps;
            }
        }

        if let (Some(pat), true) = (best_pat, best_reps >= 2) {
            lines.push(format!("loop {best_reps} {{"));
            for d in pat {
                lines.push(format!("+{d}"));
            }
            lines.push("}".into());
            i += best_reps * best_len;
        } else {
            lines.push(format!("+{}", deltas[i]));
            i += 1;
        }
    }
    lines
}

pub fn build_frame_script(events: &[ReplayEvent], anchor_frame: Option<i64>) -> String {
    let Some(anchor) = anchor_frame else {
        return String::new();
    };
    let mut jump_frames: Vec<i64> = events
        .iter()
        .filter(|e| e.name == "jump")
        .map(|e| e.frame)
        .collect();
    if jump_frames.is_empty() {
        return String::new();
    }
    jump_frames.sort_unstable();

    let mut deltas = Vec::with_capacity(jump_frames.len());
    let mut prev = anchor;
    for f in jump_frames {
        deltas.push(f - prev);
        prev = f;
    }
    emit_delta_lines(&deltas).join("\n")
}

pub fn save_replay_atomic(
    path: &Path,
    replay: &Replay,
    fps: f64,
    tap_down_ms: u64,
) -> Result<(), ReplayIoError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let jumps_count = replay.events.iter().filter(|e| e.name == "jump").count();
    let kind_str = replay.anchor_kind.as_deref().unwrap_or("None");
    let anchor_str = replay
        .anchor_frame
        .map(|f| f.to_string())
        .unwrap_or_else(|| "None".into());
    let frame_script = build_frame_script(&replay.events, replay.anchor_frame);

    let mut preamble = String::from("\"\"\"\n");
    preamble.push_str(&format!("jumps: {jumps_count}\n"));
    preamble.push_str(&format!("anchor: {kind_str}@{anchor_str}\n"));
    preamble.push_str(&format!("fps: {fps:.0}\n"));
    preamble.push_str(&format!("tap_down_ms: {tap_down_ms}\n"));
    if !frame_script.is_empty() {
        preamble.push_str("delta: true\n\n");
        preamble.push_str(&frame_script);
        preamble.push('\n');
    }
    preamble.push_str("\"\"\"\n\n");

    let json_body = serde_json::to_string_pretty(replay)?;
    let payload = format!("{preamble}{json_body}");

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, payload)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_script_and_loop_roundtrip() {
        let mut events = vec![ReplayEvent {
            frame: 10,
            name: "first_hero_update".into(),
            snap: empty_obj(),
            extra: BTreeMap::new(),
        }];
        let jump_frames = [36, 50, 101, 152, 203, 263];
        for f in jump_frames {
            events.push(ReplayEvent {
                frame: f,
                name: "jump".into(),
                snap: empty_obj(),
                extra: BTreeMap::new(),
            });
        }
        let script = build_frame_script(&events, Some(10));
        assert!(script.contains("loop 3 {\n+51\n}"), "script was:\n{script}");

        let text = format!(
            "\"\"\"\njumps: 6\nanchor: first_hero_update@10\nfps: 60\ntap_down_ms: 1\ndelta: true\n\n{script}\n\"\"\"\n"
        );
        let rec = recover_from_header_frames(&text).unwrap();
        let parsed: Vec<i64> = rec
            .events
            .iter()
            .filter(|e| e.name == "jump")
            .map(|e| e.frame)
            .collect();
        assert_eq!(parsed, jump_frames);
    }

    #[test]
    fn nested_loops_and_divergence_prefer_comment() {
        let dir = std::env::temp_dir().join("kot_tas_test_replay");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("replay.json");
        let content = r#""""
jumps: 4
anchor: first_hero_update@1
delta: true

loop 2 {
  +10
  loop 2 {
    +5
  }
}
"""

{
  "version": 3,
  "anchor_frame": 1,
  "anchor_kind": "first_hero_update",
  "events": [
    {"frame": 1, "name": "first_hero_update", "snap": {}},
    {"frame": 999, "name": "jump", "snap": {}}
  ],
  "body_frames": [{"frame": 1}]
}
"#;
        fs::write(&path, content).unwrap();
        let r = load_replay(&path);
        assert!(r.recovered);
        assert!(r.body_frames.is_empty());
        let jumps: Vec<i64> = r
            .events
            .iter()
            .filter(|e| e.name == "jump")
            .map(|e| e.frame)
            .collect();
        // 1 + 10 = 11, +5 = 16, +5 = 21, +10 = 31, +5 = 36, +5 = 41
        assert_eq!(jumps, vec![11, 16, 21, 31, 36, 41]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_replay_roundtrip_never_reads_json_numbers_as_jumps() {
        let path = std::env::temp_dir().join(format!(
            "kot_tas_roundtrip_{}_{}.json", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut events = vec![ReplayEvent {
            frame: 1, name: "first_hero_update".into(), snap: empty_obj(), extra: BTreeMap::new(),
        }];
        for i in 0..13 {
            events.push(ReplayEvent {
                frame: 24 + i * 30, name: "jump".into(), snap: empty_obj(), extra: BTreeMap::new(),
            });
        }
        let original = Replay {
            version: 3, anchor_frame: Some(1), anchor_kind: Some("first_hero_update".into()),
            events, body_frames: vec![serde_json::json!({"frame": 1, "px": 2.5})],
            timeline_ns: vec![serde_json::json!([5, 1_130_000_000i64])], ..Default::default()
        };
        save_replay_atomic(&path, &original, 60.0, 1).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let recovered = recover_from_header_frames(&text).unwrap();
        assert_eq!(recovered.recovered_jumps, 13);
        let loaded = load_replay(&path);
        assert!(!loaded.recovered);
        assert_eq!(loaded.events, original.events);
        assert_eq!(loaded.body_frames, original.body_frames);
        assert_eq!(loaded.timeline_ns, original.timeline_ns);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn json_only_is_not_a_frame_script() {
        let text = "{\n  \"version\": 3,\n  \"timeline_ns\": [[1, 999999999]],\n  \"events\": []\n}";
        assert!(frame_script_text(text).is_empty());
        assert!(parse_header_map(text).is_empty());
        assert!(recover_from_header_frames(text).is_none());
    }

    #[test]
    fn legacy_and_unclosed_scripts_stop_at_json_body() {
        let header = "jumps: 2\nanchor: first_hero_update@1\ndelta: true\n+20\n+30\n";
        let body = "{\n\"version\": 3,\n\"timeline_ns\": [\n999999999\n]\n}\n";
        for prefix in ["", "\"\"\"\n"] {
            let text = format!("{prefix}{header}{body}");
            let replay = recover_from_header_frames(&text).unwrap();
            let frames: Vec<_> = replay.events.iter().filter(|e| e.name == "jump").map(|e| e.frame).collect();
            assert_eq!(frames, vec![21, 51]);
        }
    }

    #[test]
    fn delimiter_boundary_preserves_nested_loops_and_frame_objects() {
        let text = "\u{feff}\"\"\"\r\nanchor: first_hero_update@1\r\ndelta: true\r\nloop 2 {\r\n{\"frame\": 5}\r\n}\r\n  \"\"\"  \r\n{\n\"mode\": \"comment\",\n\"timeline_ns\": [\n999999999\n]\n}";
        let replay = recover_from_header_frames(text).unwrap();
        assert_eq!(replay.recovered_jumps, 2);
        assert!(!parse_header_map(text).contains_key("mode"));
    }

}
