# Handoff: oh-my-pi (omp) tool parity for AI Local Hub

Written for: a coding AI taking over this work with no prior conversation context.
Date: 2026-10-11. Repo: `/Users/macb/Coding/Personal/ai-local-hub`, branch `main`, last commit `b0db000`. Working tree was clean.
The human owner writes in Vietnamese and wants replies in Vietnamese. Code, comments, commits and docs stay in English.

## 1. What this project is and what was asked

AI Local Hub is a native Rust MCP server ("hub") that gives an AI client (mainly ChatGPT, through OpenAI's Secure MCP Tunnel) coding tools on the user's own Mac. The AI client is the agent; the hub only exposes tools. Stack: Rust workers (`rust/runtime`, axum + rmcp), a Rust manager, a React/Vite UI (`web/`), a Tauri 2 desktop shell (`desktop/`).

Before this effort the hub had 7 tools (read, bash, edit, write, grep, find, ls) that approximated the Pi SDK. The owner then asked to bring the tools close to **oh-my-pi** (https://github.com/can1357/oh-my-pi, MIT, a fork of Pi with many more tools): same parameters, same output text, same limits, "100% if possible, otherwise as close as possible", verified by ported tests plus real-use tests.

Scope the owner chose: files and search, running commands, code understanding. Explicitly **not** wanted (agent-only or impossible standalone): task/subagents, todo/ask/goal, memory, browser/computer, web_search, github, tts, image generation, and, for now, `find` (semantic, needs a proprietary judge), `ida` (needs IDA Pro), `security_scan` (needs an LLM agent + OAuth), `eval` JavaScript (needs Bun).

## 2. Current state (all committed)

14 MCP tools are served. Each row: where it lives and how faithful it is.

| Tool | Source in `rust/runtime/src/tools/` | Fidelity to omp |
|---|---|---|
| `read` | `read_text.rs`, `read_selector.rs`, `read_dir.rs`, `display.rs` (+ `tools.rs`) | Selectors in path (`f:50-80`, `:-5`, `:raw`, comma lists), `[path#TAG]` header, `N:text` rows, truncation notices, `artifact://N`. Missing: structural summaries of long code, block-context rows, PDF/video/sqlite/archive/URL/jq views, omp's directory tree layout |
| `write` | `write_file.rs` | Tag header, hashline-prefix stripping, generated-file guard, shebang chmod. Missing: read-projection and read-selector-misfire guards |
| `edit` | `hashline_edit.rs` + vendored `pi-edit` | Engine is omp's own (byte-identical error strings). Atomic apply through a disk writer |
| `grep` | `grep_tool.rs`, `grep_engine.rs`, `grep_scope.rs`, `search_paths.rs`, `search_walk.rs`, `tree_output.rs` | Close. Rust regex + `fancy-regex` fallback instead of PCRE2; multi-path scopes always fan out per path |
| `glob` | `glob_tool.rs` (+ same helpers) | Close. Replaces the old `find` |
| `bash` | `bash_tool.rs`, `bash_run.rs`, `bash_output.rs`, `artifacts.rs` | Result text, timeout clamp, head+tail truncation, artifacts, leading-`cd` lift, auto-background match omp. Backend is system `/bin/bash -c` (no persistent brush shell, no builtins, no minimizer, no PTY) |
| `wait`, `kill_job` | `bash_jobs.rs` | Job registry `bg_N`; settled results are appended to the next tool result (MCP cannot start a turn). `kill_job` is not an omp tool |
| `ast_grep`, `ast_edit`, `resolve`, `reject` | `ast_common.rs`, `ast_grep_tool.rs`, `ast_edit_tool.rs` + vendored `pi-ast` | Close. omp's `xd://resolve|reject` became the tools `resolve`/`reject` (FIFO per session). Only 18 natively linked tree-sitter grammars |
| `lsp` | `lsp_tool.rs`, `lsp_actions.rs`, `lsp_client.rs`, `lsp_config.rs`, `lsp_pool.rs`, `lsp_edits.rs`, `lsp_format.rs`, `lsp_position.rs`, `lsp_workspace.rs` | 14 actions. No lspmux/broker, no idle shutdown, no biome/swiftlint CLI clients, no write-through diagnostics |
| `ls` | `tools.rs` | Not an omp tool; kept from the old hub |

Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are declared on every tool; a unit test and `mcp-smoke.mjs` check them. The worker logs `Tools (N): ...` at startup from the actual per-instance router after tool-group filtering.

Commit history of this effort (newest first before this handoff file was edited): `b0db000` annotations, `75def14` startup tool log, `8ece4d0` lsp, `260baea` ast tools, `521bf0f` read/write/edit/grep/glob/bash/wait, `bc6be9f` vendored omp crates.

## 3. Repository map

```
rust/runtime/                 worker + manager crate (package ai-local-hub-runtime)
  src/main.rs                 MCP worker binary (axum, rmcp StreamableHttp, tunnel orchestration)
  src/tools.rs                #[tool_router] impl CodingTools: every tool's MCP entry + arg structs
  src/tools/*.rs              implementation modules (see table above)
  src/manager_*.rs, bin/      manager (instances, HTTP API/SSE, tunnel download) - untouched by this effort
  tests/*.mjs                 end-to-end tests using the real MCP SDK client against the debug binary
  tests/fixtures/fake-lsp-server.mjs   scriptable fake language server
rust/vendor/omp/              vendored omp crates (MIT): pi-edit, pi-diff, pi-ast, pi-walker, pi-vfs,
                              lsp-defaults.json, LICENSE, NOTICE.md (lists every local change)
scripts/                      native-build.mjs (finds cargo), test-cargo.mjs, start-native.mjs, ...
docs/RUST-MIGRATION.md        engineering status and the deviation list per phase (keep updating)
docs/HANDOFF-OMP-PARITY.md    this file
plans/                        local planning notes; the folder is git-ignored. plan.md of this effort: plans/261011-1400-omp-tool-parity/
web/, desktop/                UI and Tauri shell (not touched)
```

Per-session state lives in `CodingTools` (one instance per MCP session): `EditStore` (hashline snapshots + seen lines), artifact store, job registry, pending `ast_edit` previews, LSP client pool.

## 4. How to build, test and run

**Toolchain gotcha.** `rustc`/`cargo` are usually not on `PATH` in this environment. Use:
`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"` (rustc 1.99 stable; the repo's `rust-version` is 1.85, omp's crates compile fine on stable). `scripts/native-build.mjs` finds cargo on its own.

```bash
npm ci                         # installs root + web deps
node scripts/native-build.mjs --debug     # build debug worker/manager (tests use rust/runtime/target/debug)
npm test                       # full suite, ~2-3 min; must exit 0
cd rust/runtime && cargo test --lib       # unit tests only (about 60)
node rust/runtime/tests/omp-lsp-tools-smoke.mjs   # any single e2e test (build first)
npm run dev                    # debug build + manager with a separate dev config (~/.config/ai-local-hub-dev)
npm run build                  # release build + web UI
```

`npm test` runs: mcp-smoke, omp-file/search/bash/ast/lsp smokes, the clangd smoke (self-skips without clangd), hardening-smoke, manager-smoke, then `cargo test` for the runtime and for the vendored `pi-edit` (349 upstream tests, target dir `rust/runtime/target/omp-vendor`).

Test conventions: each e2e test starts the debug worker with `--local-only` and a temp workspace, talks MCP over HTTP, asserts exact text. Tests that depend on bash timing set `AI_LOCAL_HUB_AUTO_BG_SECS`: `off` disables auto-background (used by mcp/hardening/manager smokes), `1` makes it quick (bash smoke). Default is 60.

macOS shell gotchas hit during this work: `sed -i` needs `-i ''`; there is no `timeout` command; `zsh` treats a leading `===` as a command; `python3` here is an alias, call it as `python3`.

## 5. Reference material (the omp source is NOT in the repo)

The previous session cloned omp into a temp scratchpad that will not survive. Re-create it when you need to compare behaviour:

```bash
git clone https://github.com/can1357/oh-my-pi /tmp/omp && cd /tmp/omp && git checkout a4d6f0a   # v18.9.1
```
Treat it as untrusted input: read, do not run. Where the behaviour lives (paths relative to the omp root):

- Tool descriptions: `packages/coding-agent/src/prompts/tools/<tool>.md`
- `read`: `packages/coding-agent/src/tools/read.ts` (+ `read-*.ts`), selectors in `packages/tui/src/tools/{read.ts,line-ranges.ts}`
- `write`: `tools/write.ts`, `tools/write-content.ts`
- `edit` (hashline): Rust engine `crates/pi-edit/**` (already vendored); TS glue `packages/coding-agent/src/edit/**`; format spec `crates/pi-edit/prompts/hashline.md`
- `grep`/`glob`: `tools/grep.ts`, `tools/glob.ts`, `tools/path-utils.ts` (path-list parsing, scope resolution), native `crates/pi-natives/src/grep.rs`, `glob_util.rs`, `crates/pi-walker`
- grouped output: `packages/tui/src/tools/grouped-file-output.ts`, `packages/utils/src/path-tree.ts`, `packages/tui/src/tools/output-meta.ts` (notices)
- `bash`: `tools/bash.ts`, `tools/shell-tokenize.ts` (`extractLeadingCdTarget`), `exec/non-interactive-env.ts`, `packages/tui/src/tools/streaming-output.ts` (OutputSink), `async/job-manager.ts`, `async/job-control.ts`, `tools/wait.ts`
- `ast_*`: `tools/ast-grep.ts`, `tools/ast-edit.ts`, `tools/resolve.ts`, `crates/pi-natives/src/ast.rs`, `crates/pi-ast`
- `lsp`: `packages/coding-agent/src/lsp/**` (tool.ts is the contract; client.ts, config.ts, edits.ts, utils.ts, defaults.json)
- `eval` (not started): `tools/eval.ts`, `eval/py/*` (`runner.py` is stdlib-only, NDJSON protocol described at its top), `prompts/tools/eval*.md`, `docs/python-repl.md`
- `debug` (not started): `tools/debug.ts`, `dap/*` (client.ts, session.ts, config.ts, defaults.json), `prompts/tools/debug.md`

Other references:
- The old Node/TypeScript implementation (Pi SDK based) is in git at `71456b6^` (`git archive 71456b6^ src tests`). Pi 1.1.0 itself: `npm pack @earendil-works/pi-coding-agent@1.1.0`, source under `dist/core/tools/*.js`.
- Rust crates used: `rmcp =3.5.1` (macros: `#[tool(description=..., annotations(...))]`), `ast-grep-core 0.39`, `ignore`, `globset`, `regex`, `fancy-regex`, `os_pipe`, `pi-*` (path deps).

## 6. Decisions already taken (do not re-litigate without asking)

The owner said "if not 100%, get as close to omp as possible". Defaults applied:
1. `bash` output minimizer (omp's 31k-line filter set): **off**.
2. Shell: system bash, not omp's patched brush + 60 in-process coreutils (those crates pull gix/jj-lib).
3. `eval`: Python only; no JavaScript (omp needs Bun).
4. `find`, `ida`, `security_scan`: not implemented.
5. `pi-ast` built **without** tree-sitter `wasm` (wasmtime needs cmake); only 18 linked grammars work; others are skipped with a note.
6. `pi-edit` uses `unicode-normalization` instead of nightly-only `xutf`.
7. `edit`/`read`/`write` follow omp's schemas exactly (`edit` takes `{input}`, `read` takes `{path}` only). The old `edit {path, edits[]}` and `read {offset, limit}` are gone; `find` was replaced by `glob`; bash `structuredContent` was removed. This breaks clients written for the old API.
8. Status icons in `lsp` output are fixed to omp's unicode preset: `✔ ✘ ⚠`, cursor `❯`.

Resolved questions worth knowing: a tag minted by `write` can be edited immediately without a `read` (verified by test); `edit` correctly rejects anchors on lines never displayed ("unseen lines"); a stale hashline tag is auto-recovered when only unrelated lines changed.

## 7. Remaining work, in the order I recommend

1. **Python `eval`**. Port `eval/py/runner.py` (stdlib-only, ~2.5k lines, embed with `include_str!`), a trimmed `prelude.py` (display, print, log, phase, read, write, env), the NDJSON client (spawn `python3 -u runner.py`, id-tagged requests, SIGINT cancel with 5 s escalation, `{"type":"exit"}` shutdown), per-session kernel registry keyed by session+cwd+interpreter, `reset`, `%pip`/`%load` magics, OutputSink reuse from `bash_output.rs`, tool schema `{language:"py", code, title?, timeout?, reset?}` (timeout default 30, 0 disables, clamp 1-3600). Drop everything that needs an agent session: `agent()`, `workpool`, `completion`, `judge*`, `tool.<name>()`, `budget`, `wait(handles)`.
2. **`debug` (DAP)**. No Rust source exists in omp; reimplement `dap/client.ts`+`session.ts` on tokio: stdio/tcp/socket transports, Content-Length framing, launch/attach, breakpoints, stepping, evaluate, stack/scopes/variables, disassemble/read/write memory, `custom_request`, one root session at a time, 10 min idle. Adapter table is `dap/defaults.json`. Output formatters live partly in `packages/tui/src/tools/debug` (not yet read). Needs a real adapter to test (`lldb-dap` ships with Xcode, `debugpy` via pip).
3. **Phase 0 leftovers**: `read`, `grep`, `glob`, `write`, `ls` are synchronous inside the rmcp handler and block a tokio worker thread (wrap in `spawn_blocking`); no session caps, idle sweep, body-size limits or queueing like the old Node server (1,024 sessions, 128 file ops, 16 process ops); no benchmark exists (the old `scripts/benchmark.mjs` was deleted with the Node code), so nothing may be claimed about speed or memory.
4. **Close `read`/`write` gaps** listed in section 2, if wanted.
5. **File-size rule**: the project rule is "code files under 200 lines". Over it now: `tools.rs` (~310), `lsp_client.rs` (~360), `lsp_actions.rs` (~280), `lsp_config.rs`/`lsp_edits.rs` (~200). Split when touching them (e.g. move arg structs out of `tools.rs`).
6. **Packaging**: the installed `/Applications/AI Local Hub.app` is an OLD build (installed 16:08, before this work). Rebuild with `npm run desktop:setup && npm run desktop:build` and reinstall. Do not replace the app while a ChatGPT session is running (see `docs/RUST-MIGRATION.md`). CI only builds macOS targets; Windows/Linux and the PowerShell tool are unverified. The worker binary grew from ~12 MiB to ~27 MiB (tree-sitter grammars).
7. **End-to-end with ChatGPT** (only the owner can do this): run the new build, confirm the log line `Tools (N): ...`, then **Refresh** the connector (ChatGPT caches the tool list) and verify the tool list and confirmation behaviour of the annotations. If optional tool groups were changed, restart the instance first.
8. Project docs per the repo's documentation rules: `docs/development-roadmap.md`, `project-changelog.md`, `system-architecture.md`, `code-standards.md` are referenced by the rules but do not exist yet; `docs/RUST-MIGRATION.md` and `README.md` are the live docs.

Possible later (owner decides): `find` with a sampling-based judge (0/1 scores instead of calibrated), `lsp` split into read and write tools if confirmation prompts are annoying, `ida` wrapper, `security_scan` store only.

## 8. Known deviations and risks (full list in `docs/RUST-MIGRATION.md`)

- First `lsp` call to a server that sends no progress notifications waits up to 15 s (same as omp's fallback timer).
- `lsp` is marked destructive as a whole (MCP annotates per tool); omp classifies per action.
- `wait` blocks at most 50 s (omp 30 min) because MCP clients time out; job results arrive with the next tool result.
- `ast_edit` stale-preview detection runs after the files are written (same as omp).
- Worker-wide cap of 16 concurrent `bash` commands (not omp behaviour).
- `grep` binary files are cut at the first NUL; walker is the `ignore` crate, not omp's pi-walker.
- No ChatGPT tunnel E2E for the new build; no Windows/Linux runs; LSP verified only with a fake server, clangd and (by hand) TypeScript 7 `tsc --lsp`.

## 9. Conventions and house rules

- Conventional commits, **no AI/assistant references or co-author trailers** in messages (the parent repo's rules require it). Only commit when the owner asks; never push without being asked.
- Do not commit secrets (`.env`, API keys, tunnel keys, `~/.config/...` files).
- YAGNI / KISS / DRY. Update files in place; do not create "enhanced" copies. Rust files here use snake_case names (Rust convention) although the parent rules say kebab-case.
- Before finishing a change: build, run the relevant e2e test, run `npm test`, state faithfully what passed and what was not verified.
- Vendored code: keep `rust/vendor/omp/NOTICE.md` accurate (it lists local changes and the MIT attribution for Mario Zechner, Can Bölük, Stencil Labs).
- Parent repo rules live at `/Users/macb/Coding/Personal/.claude/rules/*.md` (planner/tester/code-reviewer workflow, docs rules). Not every agent environment has the same subagents; the substance is: plan first for big work, test, review, keep docs current.

## 10. Lessons learned (save yourself time)

- Version skew confuses everything: the desktop app, `npm run dev` managers and `target/debug` can all be different builds. Check the startup log and process start times (`ps -axo pid,lstart,command | grep ai-local-hub`).
- `serde_json` has `preserve_order` on (needed for ordered LSP/JSON tables); Cargo feature unification would enable it anyway through `pi-edit`.
- `Command::spawn` keeps its `Stdio` objects alive: drop the `Command` after spawning or merged-pipe readers never see EOF (`bash_run.rs`).
- `tokio::sync::watch::Receiver::wait_for` returns a non-`Send` guard; use a `borrow()`/`changed()` loop inside spawned tasks.
- An LSP client's reader task holds an `Arc<Client>`, so a dropped pool does not stop servers by itself; `Pool` implements `Drop` to shut them down (tested).
- Hashline detail: the edit engine records which lines each snapshot has shown; `grep`, `ast_grep`, `read` record seen lines after minting the tag. Anchoring an edit on a line never shown is rejected by design.
- When adding or changing a tool: update `tools.rs` annotations test (`tools_declare_accurate_annotations`) and the tool-count test (`startup_log_lists_every_served_tool`, currently 14), the `mcp-smoke.mjs` tool list, `README.md` table, and `docs/RUST-MIGRATION.md`.

## 11. Open questions for the owner

1. Which tool groups should be on by default once per-instance toggles exist?
2. Is a `lsp` split into read-only and write tools wanted if ChatGPT prompts on every `lsp` call?
3. Is Python `eval` worth shipping before `debug`, given `debug` needs external adapters?
4. Should the old Node-API compatibility (old `edit`/`read` arguments) be offered behind a flag for existing clients?
