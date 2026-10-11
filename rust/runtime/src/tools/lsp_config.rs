//! Language-server discovery: omp's default table, `lsp.json` overrides, root markers, binary lookup.
use serde_json::Value;
use std::path::{Path, PathBuf};

const DEFAULTS: &str = include_str!("../../../vendor/omp/lsp-defaults.json");

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub name: String,
    pub command: String,
    pub resolved: PathBuf,
    pub args: Vec<String>,
    pub file_types: Vec<String>,
    pub init_options: Option<Value>,
    pub settings: Option<Value>,
    pub language_id: Option<String>,
    pub warmup_ms: Option<u64>,
    pub is_linter: bool,
}

impl ServerConfig {
    /// Everything but linters indexes the whole project (omp `isProjectAwareLspServer`).
    pub fn project_aware(&self) -> bool { !self.is_linter }
    /// Identity of a client process: binary + cwd + the options that change server behaviour.
    pub fn key(&self, cwd: &Path) -> String {
        format!("{}:{}:{}", self.resolved.display(), cwd.display(), serde_json::json!([self.args, self.init_options, self.settings, self.language_id]))
    }
}

const PYTHON_MARKERS: &[&str] = &["pyproject.toml", "ty.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "pyrightconfig.json", "ruff.toml", ".ruff.toml"];
const LOCAL_BINS: &[(&[&str], &str)] = &[
    (&["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], "node_modules/.bin"),
    (PYTHON_MARKERS, ".venv/bin"), (PYTHON_MARKERS, ".venv/Scripts"), (PYTHON_MARKERS, "venv/bin"), (PYTHON_MARKERS, "venv/Scripts"),
    (PYTHON_MARKERS, ".env/bin"), (PYTHON_MARKERS, ".env/Scripts"),
    (&["Gemfile", "Gemfile.lock"], "vendor/bundle/bin"), (&["Gemfile", "Gemfile.lock"], "bin"),
    (&["go.mod", "go.sum", "go.work"], "bin"),
];

/// Root markers live at the project root, so one directory level is enough (`*.cabal` globs included).
pub fn has_root_markers(cwd: &Path, markers: &[String]) -> bool {
    let entries: Vec<String> = std::fs::read_dir(cwd).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    markers.iter().any(|m| if m.contains('*') {
        globset::Glob::new(m).map(|g| g.compile_matcher()).is_ok_and(|g| entries.iter().any(|e| g.is_match(e)))
    } else { cwd.join(m).exists() })
}

fn which(command: &str) -> Option<PathBuf> {
    if command.contains(std::path::MAIN_SEPARATOR) { return Path::new(command).is_file().then(|| PathBuf::from(command)); }
    let path = super::shell_path().or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path).map(|d| d.join(command)).find(|p| p.is_file())
}

/// Project-local bin directories first (chosen by which markers the project has), then `$PATH`.
pub fn resolve_command(command: &str, cwd: &Path) -> Option<PathBuf> {
    for (markers, bin) in LOCAL_BINS {
        let m: Vec<String> = markers.iter().map(|s| s.to_string()).collect();
        if !has_root_markers(cwd, &m) { continue; }
        let p = cwd.join(bin).join(command);
        if p.exists() { return Some(p); }
    }
    which(command)
}

fn str_list(v: Option<&Value>) -> Vec<String> { v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() }

fn parse_server(name: &str, v: &Value) -> Option<(ServerConfig, Vec<String>)> {
    let command = v.get("command")?.as_str()?.to_string();
    let file_types = str_list(v.get("fileTypes"));
    let markers = str_list(v.get("rootMarkers"));
    if file_types.is_empty() || markers.is_empty() { return None; }
    Some((ServerConfig {
        name: name.into(), resolved: PathBuf::new(), command, args: str_list(v.get("args")), file_types,
        init_options: v.get("initOptions").or_else(|| v.get("initializationOptions")).filter(|x| x.is_object()).cloned(),
        settings: v.get("settings").filter(|x| x.is_object()).cloned(),
        language_id: v.get("languageId").and_then(Value::as_str).map(String::from),
        warmup_ms: v.get("warmupTimeoutMs").and_then(Value::as_u64),
        is_linter: v.get("isLinter").and_then(Value::as_bool).unwrap_or(false),
    }, markers))
}

/// Shallow per-server merge of `lsp.json` / `.lsp.json` in the project root over the defaults.
fn merged(cwd: &Path) -> Vec<(String, Value)> {
    let mut table: Vec<(String, Value)> = serde_json::from_str::<serde_json::Map<String, Value>>(DEFAULTS).map(|m| m.into_iter().collect()).unwrap_or_default();
    for file in ["lsp.json", ".lsp.json"].iter().rev() {
        let Ok(raw) = std::fs::read_to_string(cwd.join(file)) else { continue };
        let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(&raw) else { continue };
        if let Some(Value::Object(servers)) = obj.remove("servers") { obj = servers; }
        for (name, over) in obj {
            let Value::Object(over) = over else { continue };
            match table.iter_mut().find(|(n, _)| *n == name) {
                Some((_, base)) => { if let Value::Object(b) = base { for (k, v) in over { b.insert(k, v); } } },
                None => table.push((name, Value::Object(over))),
            }
        }
    }
    table
}

/// Servers usable for `cwd`: not disabled, a root marker present, the binary resolves.
pub fn load(cwd: &Path) -> Vec<ServerConfig> {
    let mut out = Vec::new();
    for (name, v) in merged(cwd) {
        if v.get("disabled").and_then(Value::as_bool) == Some(true) || name == "swiftlint" { continue; }
        let Some((mut cfg, markers)) = parse_server(&name, &v) else { continue };
        if !has_root_markers(cwd, &markers) { continue; }
        let Some(resolved) = resolve_command(&cfg.command, cwd) else { continue };
        cfg.resolved = resolved;
        if cfg.name == "omnisharp" { let pid = std::process::id().to_string(); cfg.args = cfg.args.iter().map(|a| a.replace("$PID", &pid)).collect(); }
        out.push(cfg);
    }
    select_typescript(&mut out);
    out
}

/// Keep one TypeScript server: native `tsc --lsp` only when the install has no `lib/tsserver.js` (TS 7+).
fn select_typescript(servers: &mut Vec<ServerConfig>) {
    let Some(native) = servers.iter().find(|s| s.name == "typescript-native") else { return };
    let Some(language_server) = servers.iter().find(|s| s.name == "typescript-language-server") else { return };
    let native_local = native.resolved.to_string_lossy().contains("node_modules/");
    let language_server_local = language_server.resolved.to_string_lossy().contains("node_modules/");
    if language_server_local && !native_local {
        servers.retain(|s| s.name != "typescript-native");
        return;
    }
    let real = std::fs::canonicalize(&native.resolved).unwrap_or_else(|_| native.resolved.clone());
    let pkg = real.parent().filter(|p| p.file_name().is_some_and(|n| n == "bin")).and_then(Path::parent).map(Path::to_path_buf);
    let speaks_lsp = pkg.is_some_and(|p| p.join("package.json").exists() && !p.join("lib/tsserver.js").exists());
    servers.retain(|s| if speaks_lsp { s.name != "typescript-language-server" } else { s.name != "typescript-native" });
}

/// Servers for a file, type-checkers before linters.
pub fn servers_for_file<'a>(servers: &'a [ServerConfig], file: &Path) -> Vec<&'a ServerConfig> {
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default();
    let name = file.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut found: Vec<&ServerConfig> = servers.iter().filter(|s| s.file_types.iter().any(|t| {
        let t = t.to_lowercase();
        let nodot = t.trim_start_matches('.');
        t == ext || t == name || nodot == ext.trim_start_matches('.') || nodot == name
    })).collect();
    found.sort_by_key(|s| s.is_linter);
    found
}

/// Primary (non-linter first) server for a file.
pub fn server_for_file<'a>(servers: &'a [ServerConfig], file: &Path) -> Option<&'a ServerConfig> { servers_for_file(servers, file).into_iter().next() }

pub fn detect_language_id(file: &Path) -> String {
    let base = file.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if base == "dockerfile" || base.starts_with("dockerfile.") || base == "containerfile" { return "dockerfile".into(); }
    match base.as_str() { "makefile" | "gnumakefile" => return "makefile".into(), "justfile" => return "just".into(), "cmakelists.txt" => return "cmake".into(), _ => {} }
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "rs" => "rust", "ts" | "mts" | "cts" => "typescript", "tsx" => "typescriptreact", "js" | "mjs" | "cjs" => "javascript", "jsx" => "javascriptreact",
        "py" | "pyi" => "python", "go" => "go", "c" | "h" => "c", "cc" | "cpp" | "cxx" | "hpp" | "hxx" | "cu" | "cuh" => "cpp", "m" => "objective-c", "mm" => "objective-cpp",
        "java" => "java", "kt" | "kts" => "kotlin", "swift" => "swift", "rb" => "ruby", "php" => "php", "cs" => "csharp", "lua" => "lua", "zig" => "zig",
        "sh" | "bash" | "zsh" => "shellscript", "json" => "json", "jsonc" => "jsonc", "yaml" | "yml" => "yaml", "toml" => "toml", "md" | "markdown" => "markdown",
        "html" | "htm" => "html", "css" => "css", "scss" => "scss", "less" => "less", "vue" => "vue", "svelte" => "svelte", "sql" => "sql", "dart" => "dart",
        "ex" | "exs" => "elixir", "hs" => "haskell", "ml" | "mli" => "ocaml", "scala" | "sc" => "scala", "tf" => "terraform", "nix" => "nix", "proto" => "proto", "xml" => "xml",
        _ => "plaintext",
    }.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cfg(name: &str, types: &[&str], linter: bool) -> ServerConfig {
        ServerConfig { name: name.into(), command: name.into(), resolved: PathBuf::from(name), args: vec![], file_types: types.iter().map(|s| s.to_string()).collect(), init_options: None, settings: None, language_id: None, warmup_ms: None, is_linter: linter }
    }
    #[test] fn defaults_table_parses_all_servers() {
        let table = merged(Path::new("/nonexistent"));
        assert_eq!(table.len(), 55);
        assert!(table.iter().all(|(n, v)| n == "biome" || n == "swiftlint" || parse_server(n, v).is_some() || v.get("command").is_some()));
    }
    #[test] fn file_routing_puts_type_checkers_first_and_accepts_dotless_types() {
        let servers = vec![cfg("ruff", &[".py"], true), cfg("pyright", &["py"], false), cfg("gopls", &[".go"], false)];
        let names: Vec<_> = servers_for_file(&servers, Path::new("/p/a.PY")).iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, ["pyright", "ruff"]);
        assert!(servers_for_file(&servers, Path::new("/p/a.rs")).is_empty());
    }
    #[test] fn project_local_binaries_beat_path_and_markers_gate_discovery() {
        let d = std::env::temp_dir().join(format!("lspcfg-{}", std::process::id()));
        std::fs::create_dir_all(d.join("node_modules/.bin")).unwrap();
        std::fs::write(d.join("package.json"), "{}").unwrap();
        std::fs::write(d.join("node_modules/.bin/typescript-language-server"), "#!/bin/sh\n").unwrap();
        let found = load(&d);
        let ts = found.iter().find(|s| s.name == "typescript-language-server").expect("local bin found");
        assert_eq!(ts.resolved, d.join("node_modules/.bin/typescript-language-server"));
        assert!(!found.iter().any(|s| s.name == "gopls"), "no go.mod marker");
        std::fs::remove_dir_all(d).ok();
    }
    #[test] fn project_overrides_merge_shallowly() {
        let d = std::env::temp_dir().join(format!("lspcfg2-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("lsp.json"), r#"{"servers":{"mine":{"command":"sh","fileTypes":[".x"],"rootMarkers":["lsp.json"]},"gopls":{"disabled":true}}}"#).unwrap();
        let found = load(&d);
        assert!(found.iter().any(|s| s.name == "mine" && s.resolved.ends_with("sh")));
        std::fs::remove_dir_all(d).ok();
    }
    #[test] fn language_ids() {
        assert_eq!(detect_language_id(Path::new("a.tsx")), "typescriptreact");
        assert_eq!(detect_language_id(Path::new("Dockerfile.dev")), "dockerfile");
        assert_eq!(detect_language_id(Path::new("x.unknown")), "plaintext");
    }
}
