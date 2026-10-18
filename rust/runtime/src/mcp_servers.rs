//! External stdio MCP servers an instance re-exposes through its own MCP endpoint.
//! The JSON shape follows the common `mcpServers` format (`command`, `args`, `env`) plus hub options.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Shown instead of every env value in API responses; sending it back keeps the saved value.
pub const HIDDEN: &str = "<hidden>";
pub const MAX_SERVERS: usize = 16;
pub const DEFAULT_TIMEOUT_SECS: u64 = 90;
/// The OpenAI tunnel cuts a request at 120 s including queue time, so calls must finish sooner.
pub const MAX_TIMEOUT_SECS: u64 = 110;
const MIN_TIMEOUT_SECS: u64 = 5;
const MAX_NAME_CHARS: usize = 32;
/// Env values shorter than this are not treated as secrets when redacting logs.
const MIN_SECRET_CHARS: usize = 6;

fn enabled_default() -> bool { true }
fn timeout_default() -> u64 { DEFAULT_TIMEOUT_SECS }
fn is_true(value: &bool) -> bool { *value }
fn is_false(value: &bool) -> bool { !*value }
fn is_default_timeout(value: &u64) -> bool { *value == DEFAULT_TIMEOUT_SECS }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Working directory; relative paths resolve against the workspace (default: the workspace).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default = "enabled_default", skip_serializing_if = "is_true")]
    pub enabled: bool,
    /// Allowlist of upstream tool names; empty exposes every tool.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    /// Pass the server's own tool annotations to ChatGPT instead of marking every tool destructive.
    #[serde(default, skip_serializing_if = "is_false")]
    pub trust_annotations: bool,
    #[serde(default = "timeout_default", skip_serializing_if = "is_default_timeout")]
    pub timeout_secs: u64,
    /// Accepted for compatibility with pasted configs; only `stdio` is supported.
    #[serde(default, rename = "type", skip_serializing)]
    pub kind: Option<String>,
    #[serde(default, skip_serializing)]
    pub url: Option<String>,
    /// Some clients write `"disabled": true` instead of `"enabled": false`.
    #[serde(default, skip_serializing)]
    pub disabled: Option<bool>,
}

pub type McpServers = BTreeMap<String, McpServerConfig>;

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && name.len() <= MAX_NAME_CHARS
        && !name.contains("__")
        // A trailing `_` would let `a_` + `x` and `a` + `_x` both become `a___x`.
        && !name.ends_with(['_', '-'])
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Replaces `<hidden>` env values with the values already saved for the same server and key.
pub fn restore_hidden(mut input: McpServers, saved: &McpServers) -> McpServers {
    for (name, server) in input.iter_mut() {
        for (key, value) in server.env.iter_mut() {
            if value == HIDDEN {
                if let Some(old) = saved.get(name).and_then(|s| s.env.get(key)) { value.clone_from(old); }
            }
        }
    }
    input
}

/// Validates and canonicalizes the servers of one instance.
pub fn normalize(input: McpServers) -> Result<McpServers> {
    if input.len() > MAX_SERVERS { bail!("At most {MAX_SERVERS} MCP servers are allowed per instance."); }
    let mut seen = std::collections::BTreeSet::new();
    let mut out = McpServers::new();
    for (name, mut server) in input {
        let name = name.trim().to_string();
        if !valid_name(&name) {
            bail!("MCP server name \"{name}\" must be 1-{MAX_NAME_CHARS} letters, digits, '-' or '_', start and end with a letter or digit, and not contain \"__\".");
        }
        if !seen.insert(name.to_ascii_lowercase()) { bail!("MCP server name \"{name}\" is used twice."); }
        if server.url.as_deref().is_some_and(|u| !u.trim().is_empty()) || server.kind.as_deref().is_some_and(|k| !k.eq_ignore_ascii_case("stdio")) {
            bail!("MCP server \"{name}\": only stdio servers (command + args) are supported.");
        }
        server.command = server.command.trim().to_string();
        if server.command.is_empty() { bail!("MCP server \"{name}\" needs a command."); }
        if server.command.contains('\0') || server.args.iter().any(|a| a.contains('\0')) { bail!("MCP server \"{name}\" has a NUL byte in its command line."); }
        for (key, value) in &server.env {
            if !valid_env_key(key) { bail!("MCP server \"{name}\": invalid env variable name \"{key}\"."); }
            if value == HIDDEN { bail!("MCP server \"{name}\": env {key} has no saved value; enter it again."); }
            if value.contains('\0') { bail!("MCP server \"{name}\": env {key} contains a NUL byte."); }
        }
        server.cwd = server.cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        server.tools = server.tools.into_iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        server.tools.sort();
        server.tools.dedup();
        if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&server.timeout_secs) {
            bail!("MCP server \"{name}\": timeoutSecs must be between {MIN_TIMEOUT_SECS} and {MAX_TIMEOUT_SECS}.");
        }
        if server.disabled == Some(true) { server.enabled = false; }
        server.kind = None;
        server.url = None;
        server.disabled = None;
        out.insert(name, server);
    }
    Ok(out)
}

/// Copy for API responses: env values are write-only.
pub fn masked(servers: &McpServers) -> McpServers {
    let mut out = servers.clone();
    for server in out.values_mut() { for value in server.env.values_mut() { *value = HIDDEN.into(); } }
    out
}

/// Env values worth redacting from logs, longest first so overlapping secrets are fully hidden.
pub fn secrets(servers: &McpServers) -> Vec<String> {
    let mut values: Vec<String> = servers.values().flat_map(|s| s.env.values().cloned()).filter(|v| v.chars().count() >= MIN_SECRET_CHARS).collect();
    values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    values.dedup();
    values
}

/// Only enabled servers are handed to the worker.
pub fn enabled(servers: &McpServers) -> McpServers {
    servers.iter().filter(|(_, s)| s.enabled).map(|(n, s)| (n.clone(), s.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: serde_json::Value) -> McpServers { serde_json::from_value(json).unwrap() }

    #[test]
    fn accepts_pasted_stdio_configs_and_canonicalizes() {
        let servers = normalize(parse(serde_json::json!({
            "playwright": {"type": "stdio", "command": " npx ", "args": ["@playwright/mcp@latest"], "disabled": true, "autoApprove": []}
        }))).unwrap();
        let server = &servers["playwright"];
        assert_eq!(server.command, "npx");
        assert!(!server.enabled);
        assert_eq!(server.timeout_secs, DEFAULT_TIMEOUT_SECS);
        let saved = serde_json::to_value(&servers).unwrap();
        assert_eq!(saved, serde_json::json!({"playwright": {"command": "npx", "args": ["@playwright/mcp@latest"], "enabled": false}}));
    }

    #[test]
    fn rejects_invalid_definitions() {
        let bad = [
            serde_json::json!({"a__b": {"command": "x"}}),
            serde_json::json!({"-a": {"command": "x"}}),
            serde_json::json!({"a_": {"command": "x"}}),
            serde_json::json!({"a": {"command": "  "}}),
            serde_json::json!({"a": {"url": "https://example.com/mcp", "command": "x"}}),
            serde_json::json!({"a": {"type": "sse", "command": "x"}}),
            serde_json::json!({"a": {"command": "x", "env": {"1BAD": "v"}}}),
            serde_json::json!({"a": {"command": "x", "timeoutSecs": 300}}),
            serde_json::json!({"a": {"command": "x", "env": {"TOKEN": HIDDEN}}}),
            serde_json::json!({"Web": {"command": "x"}, "web": {"command": "y"}}),
        ];
        for value in bad { assert!(normalize(parse(value.clone())).is_err(), "{value}"); }
    }

    #[test]
    fn hidden_values_round_trip_without_exposing_secrets() {
        let saved = normalize(parse(serde_json::json!({"gh": {"command": "gh-mcp", "env": {"TOKEN": "secret-token", "MODE": "x"}}}))).unwrap();
        let shown = masked(&saved);
        assert_eq!(shown["gh"].env["TOKEN"], HIDDEN);
        let mut edited = shown.clone();
        edited.get_mut("gh").unwrap().env.insert("MODE".into(), "y".into());
        let restored = normalize(restore_hidden(edited, &saved)).unwrap();
        assert_eq!(restored["gh"].env["TOKEN"], "secret-token");
        assert_eq!(restored["gh"].env["MODE"], "y");
        assert_eq!(secrets(&restored), vec!["secret-token".to_string()]);
    }

    #[test]
    fn only_enabled_servers_reach_the_worker() {
        let servers = normalize(parse(serde_json::json!({"a": {"command": "x"}, "b": {"command": "y", "enabled": false}}))).unwrap();
        assert_eq!(enabled(&servers).keys().collect::<Vec<_>>(), vec!["a"]);
    }
}
