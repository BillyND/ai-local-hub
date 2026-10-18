//! Text extraction for non-text documents (PDF, Office Open XML) so `read` can show their content.
use std::io::Read;

const MAX_PART_BYTES: u64 = 32 * 1024 * 1024;

/// Extracts readable text from a supported document, or `None` if the extension is not a document type.
pub fn extract(ext: &str, data: &[u8]) -> Option<Result<String, String>> {
    match ext {
        "pdf" => Some(pdf(data)),
        "docx" | "docm" => Some(office(data, &["word/document.xml"], "w:p")),
        "pptx" | "pptm" => Some(office(data, &[], "a:p")),
        "xlsx" | "xlsm" => Some(office(data, &["xl/sharedStrings.xml"], "si")),
        _ => None,
    }
}

fn pdf(data: &[u8]) -> Result<String, String> {
    let text = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(data))
        .map_err(|_| "PDF parser crashed on this file".to_string())?
        .map_err(|e| format!("Could not parse PDF: {e}"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err("PDF has no extractable text (likely a scanned image; OCR is not available).".into());
    }
    Ok(text.to_string())
}

fn office(data: &[u8], fixed: &[&str], para_tag: &str) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| format!("Not a valid Office file: {e}"))?;
    let mut names: Vec<String> = if fixed.is_empty() {
        zip.file_names().filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml")).map(String::from).collect()
    } else {
        fixed.iter().map(|s| s.to_string()).collect()
    };
    names.sort_by_key(|n| (n.len(), n.clone()));
    let mut out = String::new();
    for name in names {
        let Ok(file) = zip.by_name(&name) else { continue };
        let mut xml = String::new();
        if file.take(MAX_PART_BYTES).read_to_string(&mut xml).is_err() { continue; }
        if fixed.is_empty() { out.push_str(&format!("--- {name} ---\n")); }
        out.push_str(&xml_text(&xml, para_tag));
        out.push('\n');
    }
    let out = out.trim();
    if out.is_empty() { return Err("No text content found in this document.".into()); }
    Ok(out.to_string())
}

/// Flattens XML to text: tag content becomes text, each closing `para_tag` ends a line.
fn xml_text(xml: &str, para_tag: &str) -> String {
    let close = format!("</{para_tag}>");
    let mut out = String::new();
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        out.push_str(&unescape(&rest[..lt]));
        rest = &rest[lt..];
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[..=gt];
        if tag == close || tag.starts_with("<w:br") || tag.starts_with("<w:tab") { out.push(if tag.starts_with("<w:tab") { '\t' } else { '\n' }); }
        rest = &rest[gt + 1..];
    }
    out.push_str(&unescape(rest));
    out
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}
