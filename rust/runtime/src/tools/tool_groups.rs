//! Per-instance MCP tool group selection.
use std::collections::BTreeSet;

const CORE: &[&str] = &["read", "write", "edit", "grep", "glob", "bash", "wait", "kill_job"];
const AST: &[&str] = &["ast_grep", "ast_edit", "resolve", "reject"];
const LSP: &[&str] = &["lsp"];
const LS: &[&str] = &["ls"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolGroups { groups: BTreeSet<String> }

impl Default for ToolGroups {
    fn default() -> Self { Self::all() }
}

impl ToolGroups {
    pub fn all() -> Self { Self::from_names(["core", "ast", "lsp", "ls"]).expect("valid default tool groups") }

    pub fn from_env() -> Result<Self, String> {
        match std::env::var("AI_LOCAL_HUB_TOOL_GROUPS") {
            Ok(value) if !value.trim().is_empty() => Self::from_csv(&value),
            _ => Ok(Self::all()),
        }
    }

    pub fn from_csv(value: &str) -> Result<Self, String> {
        let items = value.split(',').map(str::trim).filter(|s| !s.is_empty());
        Self::from_names(items)
    }

    pub fn from_names<I, S>(names: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut groups = BTreeSet::new();
        let mut all = false;
        for name in names {
            let name = name.as_ref().trim().to_ascii_lowercase();
            match name.as_str() {
                "all" => { all = true; }
                "core" | "ast" | "lsp" | "ls" => { groups.insert(name); }
                "" => {}
                other => return Err(format!("Unknown tool group '{other}'. Supported groups: core, ast, lsp, ls, all")),
            }
        }
        if all { return Ok(Self::all()); }
        groups.insert("core".into());
        Ok(Self { groups })
    }

    pub fn names(&self) -> Vec<String> { self.groups.iter().cloned().collect() }

    pub fn enabled_tools(&self) -> BTreeSet<&'static str> {
        let mut tools = BTreeSet::new();
        for name in CORE { tools.insert(*name); }
        if self.groups.contains("ast") { for name in AST { tools.insert(*name); } }
        if self.groups.contains("lsp") { for name in LSP { tools.insert(*name); } }
        if self.groups.contains("ls") { for name in LS { tools.insert(*name); } }
        tools
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_every_current_tool() {
        let tools = ToolGroups::default().enabled_tools();
        assert!(tools.contains("read"));
        assert!(tools.contains("ast_grep"));
        assert!(tools.contains("lsp"));
        assert!(tools.contains("ls"));
    }

    #[test]
    fn core_is_always_enabled() {
        let groups = ToolGroups::from_names(["lsp"]).unwrap();
        let tools = groups.enabled_tools();
        assert!(tools.contains("read"));
        assert!(tools.contains("lsp"));
        assert!(!tools.contains("ast_grep"));
        assert!(!tools.contains("ls"));
        assert_eq!(groups.names(), vec!["core", "lsp"]);
    }

    #[test]
    fn rejects_unknown_groups() {
        assert!(ToolGroups::from_csv("core,debug").is_err());
    }
}
