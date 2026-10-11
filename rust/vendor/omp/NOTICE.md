# Vendored oh-my-pi crates

`pi-diff`, `pi-edit`, `pi-ast`, `pi-walker`, `pi-vfs` come from
https://github.com/can1357/oh-my-pi at commit a4d6f0a (v18.9.1), MIT licensed (see LICENSE).

Local changes:
- Cargo.toml rewritten to be standalone (no omp workspace); workspace lints dropped.
- pi-ast: tree-sitter `wasm` feature (wasmtime, needs cmake) removed. Only the 18 natively linked
  grammars work; on-demand wasm grammars report "not installed". tree-sitter-go is the crates.io 0.25
  release, not omp's patched copy (no Go 1.26 `new(expr)` support). The wasm grammar test was removed.
- pi-edit: `xutf` (nightly-only) replaced by `unicode-normalization` for NFC in text.rs.
