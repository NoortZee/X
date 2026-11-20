//! Runtime composition of a shared memory layout with either Frida agent.
use std::io;
use std::path::Path;

pub fn prepend_layout(agent_path: &Path, source: &str) -> io::Result<String> {
    let root = agent_path.parent().and_then(Path::parent).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "agent must be in a module directory")
    })?;
    let path = root.join("memory").join("offsets.js");
    let layout = std::fs::read_to_string(&path).map_err(|error| {
        io::Error::new(error.kind(), format!("{}: {error}", path.display()))
    })?;
    if layout.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} is empty", path.display()),
        ));
    }
    Ok(format!(
        "{}\n;\nif (Process.arch !== MEMORY_LAYOUT.arch) {{ throw new Error('Unsupported architecture: ' + Process.arch + '; memory layout requires ' + MEMORY_LAYOUT.arch); }}\n{}",
        layout.trim_start_matches('\u{feff}'),
        source
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_agents_load_the_same_runtime_layout() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for agent in ["TAS/agent.js", "stones/rival_hook.js"] {
            let source = prepend_layout(&root.join(agent), "// test agent").unwrap();
            assert!(source.contains("const MEMORY_LAYOUT ="));
            assert!(source.contains("Process.arch !== MEMORY_LAYOUT.arch"));
            assert!(source.ends_with("// test agent"));
        }
    }

    #[test]
    fn missing_layout_fails_instead_of_using_stale_defaults() {
        let error = prepend_layout(Path::new("/missing-kot-tas/TAS/agent.js"), "").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains("memory/offsets.js"));
    }
}
