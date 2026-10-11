//! Prefix-folded directory tree used by grouped `grep` / `glob` output (omp `path-tree.ts`).
use std::collections::HashMap;

#[derive(Default)]
pub struct Node { files: Vec<String>, dirs: Vec<(String, Node)>, dir_index: HashMap<String, usize> }

pub enum Event { Dir { depth: usize, name: String }, File { depth: usize, name: String, key: String } }

/// `entries`: (path, is_dir). Absolute paths share a leading empty segment and fold like any prefix.
pub fn build(entries: &[(String, bool)]) -> Node {
    let mut root = Node::default();
    for (raw, is_dir) in entries {
        let norm = raw.replace('\\', "/");
        let trimmed = norm.strip_suffix('/').unwrap_or(&norm);
        if trimmed.is_empty() { continue; }
        if trimmed.contains("://") { if !root.files.contains(&norm) { root.files.push(norm.clone()); } continue; }
        let segs: Vec<&str> = trimmed.split('/').collect();
        let dir_count = if *is_dir { segs.len() } else { segs.len() - 1 };
        let mut node = &mut root;
        for seg in &segs[..dir_count] {
            let idx = match node.dir_index.get(*seg) {
                Some(i) => *i,
                None => { node.dirs.push((seg.to_string(), Node::default())); node.dir_index.insert(seg.to_string(), node.dirs.len() - 1); node.dirs.len() - 1 },
            };
            node = &mut node.dirs[idx].1;
        }
        if !*is_dir { let name = segs[segs.len() - 1].to_string(); if !node.files.contains(&name) { node.files.push(name); } }
    }
    root
}

/// Depth-first events; a node's own files come before its subdirectories and single-child chains fold.
pub fn walk(node: &Node, depth: usize, prefix: &str, out: &mut Vec<Event>) {
    for f in &node.files { out.push(Event::File { depth, name: f.clone(), key: format!("{prefix}{f}") }); }
    for (name, child) in &node.dirs {
        let (mut parts, mut cur) = (vec![name.clone()], child);
        while cur.files.is_empty() && cur.dirs.len() == 1 { parts.push(cur.dirs[0].0.clone()); cur = &cur.dirs[0].1; }
        let folded = parts.join("/");
        out.push(Event::Dir { depth, name: folded.clone() });
        walk(cur, depth + 1, &format!("{prefix}{folded}/"), out);
    }
}

pub fn events(entries: &[(String, bool)]) -> Vec<Event> {
    let mut out = Vec::new();
    walk(&build(entries), 0, "", &mut out);
    out
}

/// Bare grouped listing: `# dir/` headers with files beneath (omp `formatGroupedPaths`).
pub fn format_grouped_paths(paths: &[String]) -> String {
    let entries: Vec<(String, bool)> = paths.iter().map(|p| (p.clone(), p.ends_with('/'))).collect();
    events(&entries).into_iter().map(|e| match e {
        Event::Dir { depth, name } => format!("{} {name}/", "#".repeat(depth + 1)),
        Event::File { name, .. } => name,
    }).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn folds_single_child_chains_and_keeps_input_order() {
        let paths = ["src/a/b/x.rs", "src/a/b/y.rs", "README.md"].map(String::from);
        assert_eq!(format_grouped_paths(&paths), "README.md\n# src/a/b/\nx.rs\ny.rs");
    }
    #[test] fn nests_when_a_directory_has_its_own_files() {
        let paths = ["a/f.rs", "a/b/g.rs", "a/c/h.rs"].map(String::from);
        assert_eq!(format_grouped_paths(&paths), "# a/\nf.rs\n## b/\ng.rs\n## c/\nh.rs");
    }
    #[test] fn directory_leaves_keep_their_slash() {
        assert_eq!(format_grouped_paths(&["src/".to_string(), "src/lib/".to_string()]), "# src/lib/");
    }
}
