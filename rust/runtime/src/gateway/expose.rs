//! How upstream tools are presented to the AI client: names, annotations and result size.
use rmcp::model::{CallToolResult, ContentBlock, Tool, ToolAnnotations};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// OpenAI function names allow `[A-Za-z0-9_-]{1,64}`.
const MAX_TOOL_NAME: usize = 64;
/// Leaves headroom under the tunnel's 10 MiB envelope for JSON-RPC framing and metadata.
pub const RESULT_BUDGET: usize = 8 * 1024 * 1024;
const NOTICE_RESERVE: usize = 512;

fn short_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// `<server>__<tool>` with invalid characters replaced; long or colliding names get a stable hash suffix.
pub fn exposed_name(server: &str, tool: &str, taken: &HashSet<String>) -> String {
    let clean: String = tool.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    let plain = format!("{server}__{clean}");
    if clean == tool && plain.len() <= MAX_TOOL_NAME && !taken.contains(&plain) { return plain; }
    // Sanitized, too long or colliding: a hash of the original name keeps it unique and stable across restarts.
    format!("{}_{}", &plain[..plain.len().min(MAX_TOOL_NAME - 9)], short_hash(tool))
}

/// Copies an upstream tool for the client. Untrusted servers get conservative hints so ChatGPT asks first.
pub fn present(server: &str, upstream: &Tool, exposed: String, trust_annotations: bool) -> Tool {
    let mut tool = upstream.clone();
    tool.name = exposed.into();
    let description = upstream.description.as_deref().unwrap_or("").trim();
    tool.description = Some(if description.is_empty() { format!("[{server}] Tool `{}` from the {server} MCP server.", upstream.name) } else { format!("[{server}] {description}") }.into());
    let title = upstream.annotations.as_ref().and_then(|a| a.title.clone()).or_else(|| upstream.title.clone());
    let mut hints = if trust_annotations { upstream.annotations.clone().unwrap_or_default() } else { ToolAnnotations::default() };
    if !trust_annotations {
        hints.read_only_hint = Some(false);
        hints.destructive_hint = Some(true);
        hints.idempotent_hint = Some(false);
        hints.open_world_hint = Some(true);
    }
    hints.title = title;
    tool.annotations = Some(hints);
    // Widget templates and other `_meta` refer to resources this gateway does not proxy.
    tool.meta = None;
    tool
}

fn size<T: serde::Serialize>(value: &T) -> usize { serde_json::to_vec(value).map(|v| v.len()).unwrap_or(usize::MAX) }

fn truncate_text(text: &str, bytes: usize) -> String {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) { end -= 1; }
    text[..end].to_string()
}

/// Keeps a result inside the tunnel envelope: oversized blocks are cut or replaced by a notice.
pub fn fit(mut result: CallToolResult, budget: usize) -> CallToolResult {
    if size(&result) <= budget { return result; }
    let mut remaining = budget.saturating_sub(NOTICE_RESERVE * 2);
    let mut notes = Vec::new();
    if let Some(structured) = result.structured_content.take() {
        let bytes = size(&structured);
        if bytes <= remaining / 2 { remaining -= bytes; result.structured_content = Some(structured); } else {
            notes.push(format!("structured content omitted ({bytes} bytes)"));
            // Clients validate `structuredContent` against the tool's output schema unless the result is an error.
            result.is_error = Some(true);
        }
    }
    let (mut kept, mut omitted, mut omitted_bytes) = (Vec::new(), 0usize, 0usize);
    for block in std::mem::take(&mut result.content) {
        let bytes = size(&block);
        if bytes + NOTICE_RESERVE <= remaining { remaining -= bytes; kept.push(block); continue; }
        match block.as_text() {
            Some(text) if remaining > NOTICE_RESERVE * 2 => {
                let cut = truncate_text(&text.text, remaining - NOTICE_RESERVE * 2);
                notes.push(format!("text cut from {} to {} bytes", text.text.len(), cut.len()));
                remaining = NOTICE_RESERVE;
                kept.push(ContentBlock::text(cut));
            }
            _ => { omitted += 1; omitted_bytes += bytes; }
        }
    }
    if omitted > 0 { notes.push(format!("{omitted} content block(s) omitted ({omitted_bytes} bytes)")); }
    kept.push(ContentBlock::text(format!("[Result trimmed to fit the 10 MiB tunnel limit: {}.]", notes.join("; "))));
    result.content = kept;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn tool(name: &str) -> Tool {
        let mut t = Tool::new(name.to_string(), "Does things", Arc::new(serde_json::Map::new()));
        t.annotations = Some(ToolAnnotations::default().read_only(true));
        t
    }

    #[test]
    fn names_are_prefixed_sanitized_and_bounded() {
        let mut taken = HashSet::new();
        assert_eq!(exposed_name("pw", "browser_click", &taken), "pw__browser_click");
        let dotted = exposed_name("pw", "browser.click", &taken);
        assert!(dotted.starts_with("pw__browser_click_") && dotted.len() == "pw__browser_click_".len() + 8, "{dotted}");
        let long = exposed_name("server", &"x".repeat(100), &taken);
        assert_eq!(long.len(), 64);
        taken.insert("pw__a".to_string());
        assert_ne!(exposed_name("pw", "a", &taken), "pw__a");
        for name in [dotted, long] { assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')); }
    }

    #[test]
    fn untrusted_tools_always_ask_and_trusted_keep_hints() {
        let forced = present("fs", &tool("read"), "fs__read".into(), false);
        let hints = forced.annotations.unwrap();
        assert_eq!((hints.read_only_hint, hints.destructive_hint, hints.open_world_hint), (Some(false), Some(true), Some(true)));
        assert_eq!(forced.description.as_deref(), Some("[fs] Does things"));
        let trusted = present("fs", &tool("read"), "fs__read".into(), true);
        assert_eq!(trusted.annotations.unwrap().read_only_hint, Some(true));
    }

    #[test]
    fn oversized_results_are_trimmed_under_budget() {
        let big = "é".repeat(3_000);
        let result = CallToolResult::success(vec![ContentBlock::text(big), ContentBlock::image("A".repeat(5_000), "image/png")]);
        let trimmed = fit(result, 4_000);
        assert!(size(&trimmed) <= 4_000, "{}", size(&trimmed));
        let last = trimmed.content.last().unwrap().as_text().unwrap().text.clone();
        assert!(last.contains("tunnel limit") && last.contains("omitted"), "{last}");
        let many = CallToolResult::success((0..2_000).map(|_| ContentBlock::text("y".repeat(50))).collect());
        let trimmed = fit(many, 4_000);
        assert!(size(&trimmed) <= 4_000, "notice must not grow with the number of dropped blocks");
        let mut structured = CallToolResult::success(vec![ContentBlock::text("ok")]);
        structured.structured_content = Some(serde_json::json!({"data": "z".repeat(5_000)}));
        let trimmed = fit(structured, 4_000);
        assert_eq!((trimmed.structured_content.is_none(), trimmed.is_error), (true, Some(true)));
        let small = CallToolResult::success(vec![ContentBlock::text("ok")]);
        assert_eq!(fit(small.clone(), 4_000), small);
    }
}
