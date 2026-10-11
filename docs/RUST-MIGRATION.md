# Rust Migration — engineering status

Date: 2026-10-11. Project: AI Local Hub.

## Runtime architecture

```text
Tauri 2 (Rust; tray/window, no Bun)
   └── ai-local-hub-manager (Rust; Axum/serde/Tokio)
       ├── static web UI (React/Vite; same REST/SSE contract)
       ├── instance configuration v1/v2 (private JSON file)
       ├── shared official tunnel-client cache/verifier
       ├── instance A: ai-local-hub-runtime (Rust)
       │      ├── MCP Streamable HTTP (rmcp; loopback)
       │      ├── coding tools (native Rust)
       │      └── official OpenAI tunnel-client (external native binary)
       └── instance B: same isolated structure
```

This design uses one manager plus independent worker processes, because crashes in an MCP worker or a tunnel should not bring down unrelated instances. The React UI is static, not a Node.js or Bun backend.

### Migrated to native Rust

- Manager HTTP API and event stream: `/api/state`, `/api/events`, `/api/fs`, `/api/instances`, `/api/instances/:id/{start,stop,logs}`, `/api/start-all`, `/api/stop-all`, `/api/shutdown`.
- Persistence, old config paths and environment names, v1→v2 legacy parsing, 0600 key storage.
- Per-instance worker spawning, readiness events, bounded in-memory logs, graceful stop/escalation and stdout/stderr redaction.
- MCP protocol over localhost via the official Rust MCP SDK (`rmcp`).
- Coding tools `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; Windows PowerShell parity is still a follow-up.
- Official OpenAI tunnel-client download with GitHub checksum verification, isolated child process and health/readiness checks.
- Tauri 2 shell launches native Rust sidecars rather than Bun. The previously required unsafe macOS JIT entitlements have been removed.
- Cargo and JS build scripts, GitHub CI changes to build native sidecars, smoke tests.

### Verified on macOS arm64

- `cargo check` and Rust unit tests.
- `npm run build`: Rust release binary and React static build.
- `node rust/runtime/tests/mcp-smoke.mjs`: real MCP SDK initialize and all seven macOS tools with file edits and image content.
- `node rust/runtime/tests/manager-smoke.mjs`: authenticated HTTP manager, config CRUD, native worker lifecycle and MCP write through the manager.
- `npm test`: all the above and `cargo test`.
- Desktop Rust shell compiled with `tauri build --no-bundle` after clearing stale build artifacts containing absolute paths from the previous repository name.
- `stage-rust-desktop.mjs`: native Rust binaries copied into the Tauri sidecar locations; React assets staged.

The release worker is roughly 12 MiB and manager 8 MiB on this macOS arm64 build (file size, **not RAM**); the previous embedded Bun runtime was about 67 MiB. **No benchmark comparing memory/latency under equal load has been completed yet.** Do not claim unmeasured speed-ups.

### Important incomplete compatibility work

1. **Pi SDK exact parity:** Native tools match the common operations and signatures, but do not yet implement every advanced Pi SDK behavior (automatic image resize, mid-command MCP progress callbacks, output formatting details, argument normalization).
2. **Concurrency:** The legacy Node server had documented limits for 1,024 initialized sessions, 128 active file operations, 16 active process operations, bounded queues and idle-session sweeping. Those exact limits are **not yet reproduced or load-tested in the new `rmcp` transport**. Do not advertise the 1,000-session benchmark as passing on Rust.
3. **OpenAI tunnel E2E:** Only local-only tests were run. A connected ChatGPT account, tunnel ID and runtime key are needed to verify remote end-to-end connectivity. Never log or copy actual keys into tests.
4. **Platform coverage:** macOS arm64 was exercised; Intel macOS cross-compilation, Windows and Linux builds and the Windows-specific PowerShell tool require verification. CI currently builds macOS targets only.
5. **Desktop installer/signing:** Tauri compile and native resource staging passed; signed/notarized app and installation UX still need final validation.
6. **Reliability/performance:** Need repeated benchmarks with identical workloads, shell timeout/long-output stress tests, heavy concurrency testing and failure-injection across worker/tunnel lifecycle before declaring production parity.

### Native commands

```bash
npm ci
npm run build
npm test
npm start -- --local-only
npm run desktop:build
```

The old TypeScript implementation and tests remain as a reference during the transition. Do not delete them until matching contract tests pass for every supported platform.

### Rollback

Existing user config was not reset. Since the old JS source and lockfile are retained, the original manager can still be rebuilt and run from the original sources if necessary. The migration deliberately does not automatically start/stop existing live manager processes.

## Native reliability hardening (11 October 2026, second audit)

Implemented:
- Shell replies now include a structured `output` field, `exit_code`, `timed_out`, wall time and an accurate truncation flag. Output is drained with bounded buffers. A Unix request cancellation kills its process group.
- A worker-wide, shared 16-command semaphore bounds shell concurrency. Shell subprocess PATH is extended with conventional macOS development paths when launched from a GUI session.
- Text/image read and edit/write are limited to 32 MiB per file. Grep has a 64 MiB total scan budget, maximum 20,000 files, and capped matching-line output to avoid unbounded result memory.
- Atomic edit follows existing symlink targets and uses randomized sibling temp-file names.
- MCP Host validation checks the exact local port, and the worker's shutdown uses a broadcast watch channel. Failed tunnel startup removes its runtime profile.
- Instance updates/deletes save a copy before mutating in-memory state, keeping the manager coherent if disk saving fails.
- The macOS release binary is stripped using Apple's native utility rather than relying on the local rust-objcopy installation.
- Integration tests now exercise errors, truncation, timeout, symlinks, multiple workers and failed saves. Rust unit tests expanded from 2 to 8.
- Packaging validation checks all three native binaries and verifies that a final DMG exists and has a valid checksum.

Still **not** guaranteed:
- The app provides full shell/filesystem access by design; workspace is not a security boundary. A sandbox/permission engine is a separate feature.
- Native `rmcp` session quotas, idle sweeps and Pi SDK-compatible streaming/progress/image resizing have not reached full legacy parity.
- App installation / self-update / signing / notarization, remote tunnel end-to-end for the *latest* build, x86 macOS, Windows and Linux need platform-specific validation.
- A numeric 100% line/branch code-coverage claim would be misleading without an instrumented coverage measurement and comprehensive platform tests.
- The current source fixes are not automatically deployed to the already-running /Applications app. Do not overwrite a running MCP process during an active ChatGPT session.

## oh-my-pi tool parity (11 October 2026)

Goal: approach oh-my-pi (omp) tool behaviour. Plan: `plans/261011-1400-omp-tool-parity/plan.md`.

Done (phase 1: read / write / edit):
- Vendored omp crates `pi-edit`, `pi-diff`, `pi-ast`, `pi-walker`, `pi-vfs` in `rust/vendor/omp` (MIT, see `NOTICE.md`). All 349 `pi-edit` tests pass on stable Rust (`scripts/test-cargo.mjs`).
- `edit` is the omp hashline tool (`{input}`), `read` takes selectors in `path`, `write` mints snapshot tags. Per MCP session `EditStore` keeps snapshots and seen lines.
- Real MCP-client test: `rust/runtime/tests/omp-file-tools-smoke.mjs`.

Known deviations from omp:
- `pi-ast` built without tree-sitter `wasm`: only the 18 linked grammars work for block ops; other languages degrade (block `N*` ops fail with a clear message). tree-sitter-go is the crates.io release.
- `read`: no structural summaries of long code files, no block-context rows, no PDF/video/sqlite/archive/URL/jq views, simplified directory listing, multi-range joined by a `…` row.
- `write`: no read-projection / read-selector-misfire guards yet; writes are not atomic (omp's are not either).
- Worker binary grew from ~12 MiB to ~27 MiB (tree-sitter grammars; measured on macOS arm64 release).

Phase 2 (grep / glob) done: `tools/grep_*.rs`, `tools/glob_tool.rs`, `search_*.rs`, `tree_output.rs`. Real MCP test: `omp-search-tools-smoke.mjs`. `find` was replaced by `glob` (omp's `find` is LLM-judged semantic search and is not implemented).

Grep/glob deviations from omp: matcher is Rust regex with a `fancy-regex` fallback instead of PCRE2; multi-path scopes always fan out per path (omp sometimes collapses to one walk, which can change file order); no internal-URL, archive or external-URL scopes; the walker is the `ignore` crate, not omp's pi-walker (global-gitignore rules may differ outside git repos); binary files are cut at the first NUL byte.

Phase 3 (bash / wait) done with a **system bash backend**: `tools/bash_run.rs` (merged pipe, TERM then KILL of the process group, timeout, cancel), `bash_output.rs` (head+tail, column cap, notices), `bash_jobs.rs` (`bg_N` registry, `wait`, delivery with the next tool result), `bash_tool.rs` (leading-`cd` lift, timeout clamp, auto-background), `artifacts.rs`. Real MCP test: `omp-bash-tools-smoke.mjs`.

Bash deviations from omp: system `/bin/bash -c` per call instead of omp's persistent patched-brush shell with 60 in-process coreutils (no state persists between calls); no output minimizer; no PTY (`pty:true` is ignored with omp's notice); no `name`/`ready` service mode; MCP cannot start a turn, so settled jobs are appended to the next tool result and `wait` has a 50s cap (omp: 30 min); extra `kill_job` tool; worker-wide cap of 16 concurrent commands. `structuredContent` (exit_code, timed_out...) of the old tool was removed to match omp's text result.

Phase 4 (ast_grep / ast_edit) done on the vendored `pi-ast`: `tools/ast_common.rs`, `ast_grep_tool.rs`, `ast_edit_tool.rs`. Real MCP test: `omp-ast-tools-smoke.mjs`.

AST deviations from omp: omp's `xd://resolve` / `xd://reject` devices became the MCP tools `resolve` / `reject` (FIFO per session; same texts, including the stale-preview message); only the 18 linked grammars work (no on-demand wasm grammars, so other languages are skipped with a note); like omp, a stale preview is detected after the files were written.

Phase 5 (lsp) done: `tools/lsp_client.rs` (JSON-RPC client, document sync, push + pull diagnostics, progress), `lsp_pool.rs`, `lsp_config.rs` (omp's `lsp-defaults.json`, `lsp.json` overrides, root markers, TypeScript server selection), `lsp_edits.rs` (UTF-16 text edits, workspace edits, rollback), `lsp_format.rs`, `lsp_position.rs`, `lsp_actions.rs`, `lsp_tool.rs`, `lsp_workspace.rs`. Tests: `omp-lsp-tools-smoke.mjs` (scriptable fake server, every action) and `omp-lsp-real-server-smoke.mjs` (clangd, skipped when absent). Also verified by hand against TypeScript 7 native (`tsc --lsp`): diagnostics (pull model), definition, references, hover, symbols, project-wide rename, `rename_file` rewriting imports.

LSP deviations from omp: no lspmux / shared-server broker, no idle shutdown of servers, no biome / swiftlint CLI linter clients, no write-through diagnostics (that belongs to omp's edit/write tools), a client is created lazily per MCP session and stopped when the session ends; like omp, the first call to a server that sends no progress notifications waits up to 15s for project load; status icons are fixed to the unicode preset (`✔ ✘ ⚠`, `❯`).

Phase 6 (per-instance tool groups) done: manager config stores `toolGroups`, the UI exposes optional `ast` / `lsp` / `ls` checkboxes, and the worker reads `AI_LOCAL_HUB_TOOL_GROUPS` to filter MCP `list_tools` and calls through rmcp's route disabling. `core` is always enabled (`read`, `write`, `edit`, `grep`, `glob`, `bash`, `wait`, `kill_job`). Real manager test verifies a second instance started with only `core` exposes exactly those tools.

Not started: debug, eval (see plan).
