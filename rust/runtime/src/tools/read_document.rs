//! Text extraction for non-text documents (PDF, Office Open XML) so `read` can show their content.
//! Extraction stops once `limit` bytes of text exist, since `read` shows no more than that.
use std::{io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::OnceLock, time::{Duration, Instant}};

const MAX_PART_BYTES: u64 = 32 * 1024 * 1024;
/// Decompressed bytes read across all parts of one Office file (zip-bomb guard).
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const PDF_TIMEOUT: Duration = Duration::from_secs(45);
/// Argument that turns the runtime binary into a one-shot PDF extractor (see `pdf_worker_main`).
pub const PDF_WORKER_FLAG: &str = "--extract-pdf";

static PDF_WORKER: OnceLock<PathBuf> = OnceLock::new();

/// Extracts PDFs in a child process (`exe --extract-pdf <file>`): a malformed file can overflow the parser's
/// stack, which aborts the whole process and cannot be caught in-process. Without it, PDFs parse in-process.
pub fn use_pdf_worker(exe: PathBuf) { let _ = PDF_WORKER.set(exe); }

/// Extracts readable text from a supported document, or `None` if the extension is not a document type.
pub fn extract(ext: &str, path: &Path, limit: usize) -> Option<Result<String, String>> {
    let read = || std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()));
    let office_parts: (&[&str], &str) = match ext {
        "pdf" => return Some(match PDF_WORKER.get() { Some(exe) => pdf_in_worker(exe, path, limit), None => read().and_then(|d| pdf_in_process(&d)) }),
        "docx" | "docm" => (&["word/document.xml"], "w:p"),
        "pptx" | "pptm" => (&[], "a:p"),
        "xlsx" | "xlsm" => (&["xl/sharedStrings.xml"], "si"),
        _ => return None,
    };
    Some(read().and_then(|d| office(&d, office_parts.0, office_parts.1, limit)))
}

fn non_empty_pdf(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() { return Err("PDF has no extractable text (likely a scanned image; OCR is not available).".into()); }
    Ok(text.to_string())
}

fn pdf_in_process(data: &[u8]) -> Result<String, String> {
    let text = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(data))
        .map_err(|_| "PDF parser crashed on this file".to_string())?
        .map_err(|e| format!("Could not parse PDF: {e}"))?;
    non_empty_pdf(&text)
}

/// Runs the extractor child with a deadline, keeps the first `limit` bytes of its output, then stops it.
fn pdf_in_worker(exe: &Path, path: &Path, limit: usize) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.arg(PDF_WORKER_FLAG).arg(path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; cmd.process_group(0); }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the PDF extractor: {e}"))?;
    // Lets runtime shutdown stop an extraction that is still running.
    let mut group = super::process_group::Guard::new(Some(child.id()));
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else { return Err("PDF extractor pipes unavailable".into()) };
    let text = std::thread::spawn(move || { let mut buf = Vec::new(); let _ = stdout.take(limit as u64 + 1).read_to_end(&mut buf); buf });
    let errors = std::thread::spawn(move || { let mut buf = Vec::new(); let _ = stderr.take(4096).read_to_end(&mut buf); buf });
    let deadline = Instant::now() + PDF_TIMEOUT;
    let stopped = loop {
        if text.is_finished() { break None; }
        if super::cancel::requested() { break Some("PDF extraction was cancelled".to_string()); }
        if Instant::now() >= deadline { break Some(format!("PDF extraction timed out after {}s", PDF_TIMEOUT.as_secs())); }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Past the limit the rest is never shown; the child is stopped instead of finishing the document.
    let _ = child.kill();
    let status = child.wait();
    group.release();
    if let Some(reason) = stopped { return Err(reason); }
    let out = text.join().unwrap_or_default();
    let message = String::from_utf8_lossy(&errors.join().unwrap_or_default()).trim().to_string();
    let succeeded = matches!(&status, Ok(s) if s.success());
    // More than `limit` bytes means the child was stopped on purpose once enough text existed.
    if out.len() > limit || succeeded { return non_empty_pdf(&String::from_utf8_lossy(&out)); }
    // Exit code 1 is the extractor reporting an error; anything else (a signal, a panic) is a crash.
    let reason = match &status {
        Ok(s) if s.code() == Some(1) && !message.is_empty() => message,
        _ => "PDF parser crashed on this file (malformed or unsupported PDF)".to_string(),
    };
    let partial = String::from_utf8_lossy(&out);
    let partial = partial.trim();
    if partial.is_empty() { return Err(reason); }
    Ok(format!("[PDF extraction stopped early ({reason}); the text below is incomplete.]\n{partial}"))
}

/// Entry point of the PDF extractor child: streams the text of `path` to stdout.
pub fn pdf_worker_main(path: Option<std::ffi::OsString>) -> i32 {
    let Some(path) = path else { eprintln!("Missing PDF path"); return 2 };
    let result = (|| -> Result<(), String> {
        let mut doc = pdf_extract::Document::load(&path).map_err(|e| format!("Could not parse PDF: {e}"))?;
        if doc.is_encrypted() { doc.decrypt("").map_err(|e| format!("Could not parse PDF: {e}"))?; }
        let mut out = std::io::BufWriter::new(std::io::stdout().lock());
        let writer: &mut dyn Write = &mut out;
        pdf_extract::output_doc(&doc, &mut pdf_extract::PlainTextOutput::new(writer)).map_err(|e| format!("Could not parse PDF: {e}"))?;
        out.flush().map_err(|e| e.to_string())
    })();
    match result { Ok(()) => 0, Err(e) => { eprintln!("{e}"); 1 } }
}

fn office(data: &[u8], fixed: &[&str], para_tag: &str, limit: usize) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| format!("Not a valid Office file: {e}"))?;
    let mut names: Vec<String> = if fixed.is_empty() {
        zip.file_names().filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml")).map(String::from).collect()
    } else {
        fixed.iter().map(|s| s.to_string()).collect()
    };
    names.sort_by_key(|n| (n.len(), n.clone()));
    let (mut out, mut budget) = (String::new(), MAX_TOTAL_BYTES);
    for name in names {
        if out.len() > limit || budget == 0 { break; }
        let Ok(file) = zip.by_name(&name) else { continue };
        let mut raw = Vec::new();
        if file.take(MAX_PART_BYTES.min(budget)).read_to_end(&mut raw).is_err() { continue; }
        budget -= raw.len() as u64;
        // A part cut at the byte cap can end mid-character; keep what decodes.
        let xml = String::from_utf8_lossy(&raw);
        if fixed.is_empty() { out.push_str(&format!("--- {name} ---\n")); }
        out.push_str(&xml_text(&xml, para_tag, limit.saturating_sub(out.len())));
        out.push('\n');
    }
    let out = out.trim();
    if out.is_empty() { return Err("No text content found in this document.".into()); }
    Ok(out.to_string())
}

/// Flattens XML to text: tag content becomes text, each closing `para_tag` ends a line. Stops past `limit` bytes.
fn xml_text(xml: &str, para_tag: &str, limit: usize) -> String {
    let close = format!("</{para_tag}>");
    let mut out = String::new();
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        if out.len() > limit { return out; }
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
    if !s.contains('&') { return s.to_string(); }
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn docx(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut z = zip::ZipWriter::new(&mut buf);
        for (name, body) in parts { z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap(); z.write_all(body.as_bytes()).unwrap(); }
        z.finish().unwrap();
        buf.into_inner()
    }
    #[test] fn office_text_is_flattened_per_paragraph() {
        let data = docx(&[("word/document.xml", "<w:p><w:t>Hello &amp; bye</w:t></w:p><w:p><w:t>Two</w:t></w:p>")]);
        assert_eq!(office(&data, &["word/document.xml"], "w:p", 50_000).unwrap(), "Hello & bye\nTwo");
    }
    #[test] fn office_extraction_stops_past_the_limit() {
        let slides: Vec<(String, String)> = (1..=200).map(|i| (format!("ppt/slides/slide{i}.xml"), format!("<a:p>{}</a:p>", "x".repeat(1000)))).collect();
        let parts: Vec<(&str, &str)> = slides.iter().map(|(n, b)| (n.as_str(), b.as_str())).collect();
        let text = office(&docx(&parts), &[], "a:p", 5_000).unwrap();
        assert!(text.len() < 8_000 && text.contains("slide1.xml") && !text.contains("slide200.xml"), "{}", text.len());
    }
}
