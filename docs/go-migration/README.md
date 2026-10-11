# Go + Wails migration — development checkpoint

Date: **2026-10-11**. Repository: `/Users/macb/Coding/Personal/ai-local-hub`.

**Status: PARTIAL MIGRATION, DO NOT PACKAGE / RELEASE DESKTOP.** The Rust/Tauri application remains the active production implementation. All new Go work lives in `go/`. No existing config, state, app binary, or running process was intentionally changed. The main `build`, `start`, and `desktop:build` scripts still target Rust/Tauri, so rollback requires no migration or data reset.

## Constraints and architecture

```text
Current production — unchanged       Go development — isolated config & port
Tauri 2 shell                         [Wails shell NOT implemented]
     |                                            |
Rust Manager (HTTP, SSE, config)       Go Manager (net/http, config, subprocess)
     |                                            |
Rust MCP worker (rmcp)                 Go MCP worker (official Go MCP SDK v1.8.0)
     |                                            |
Official tunnel-client                 Official tunnel-client (fake E2E tested)
     |                                            |
ChatGPT                                 ChatGPT remote E2E NOT verified
```

- Go 1.27.2, official SDK `github.com/modelcontextprotocol/go-sdk/mcp` v1.8.0, stdlib HTTP, fs, subprocess, crypto.
- The existing React/Vite/TypeScript/Tailwind/shadcn UI is reused over the same REST and SSE protocol; it has not been copied or redesigned.
- Manager and worker run as separate processes. Worker crashes do not directly terminate Manager. Local-only mode is the default recommended development path.
- Development CLI requires `WORKSPACE_TOOLS_CONFIG_FILE` to be explicitly set; it will not silently open the production config. `npm run dev:go` generates an isolated temp config automatically. `--allow-existing-config` is a dangerous explicit opt-in and should **not** be used while Rust production is running.
- Remote Go tunnel opt-in requires `--experimental-remote`; only fake binary E2E is tested. Use non-production credentials for experiments.
- Secret fields are omitted from API views; on Unix, written config files use 0600 permissions. API tokens are only accepted through `?token=` bootstrap and HttpOnly SameSite cookies. Both REST and MCP HTTP bind to loopback.

## Feature compatibility matrix

| Feature | Legacy Rust/TS | Go status | Evidence / open issue |
| --- | --- | --- | --- |
| Config v1→v2 parsing, credential retention | Yes | PASS (unit) | `go/internal/config/config_test.go` |
| Atomic save and 0600 | Yes | PASS (unit) | Tested success, invalid target path |
| Manager create/update/delete, duplicate reject | Yes | PASS (smoke) | `go/tests/manager-smoke.mjs` |
| Start/stop, start-all/stop-all | Yes | PASS (smoke) | Two isolated workers; retry/crash endurance not done |
| UI `/api/state`, `/api/instances`, `/api/fs`, `/api/events` | Yes | PARTIAL | REST smoke, SSE implementation; browser UI E2E and SSE delivery load untested |
| Cookie auth, Host/Origin checking | Yes | PASS (smoke) | Unauthorized/cross-origin/forged Host tested |
| MCP Streamable HTTP initialize and tools/list | Yes | PASS (smoke) | Official SDK client used in real calls |
| `read`, `write`, `edit`, `bash`, `ls` | Yes | PASS basic tests | Unicode, image, symlink, atomic edit, timeout, truncation |
| `grep`, `find` | Yes | PARTIAL | Basic calls PASS; `.gitignore`, glob, context, and symlink behavior not exact |
| Pi SDK full fidelity, progress/image transform | Partial in Rust | NOT PARITY | Need differential contract tests vs original JS Pi tools |
| Shell process groups, 16 simultaneous commands | Yes | PARTIAL | Unix process groups, bounded output; cancellation and process saturation need stress tests |
| MCP session quota, queue/backpressure | Legacy TS yes, Rust partial | NOT PARITY | Go SDK idle timeout is 15 min; no proven 1024-session/128-file queue cap |
| Recovery after manager crash / orphan cleanup | Yes/partial | NOT VERIFIED | Add kill/restart/fault injection matrix |
| Tunnel verified release download | Yes | PARTIAL | SHA256/hash/extractor unit tests; real GitHub download not exercised for Go |
| Tunnel init/run/readiness/profile cleanup | Yes | PASS fake fixture | `go/tests/tunnel-fixture-smoke.mjs` |
| Live ChatGPT tunnel connectivity | Yes (old live app) | BLOCKED | No remote Go E2E performed; do not claim PASS |
| Legacy saved config read by Go | Yes | PASS fixture only | Never replace existing user config without a read-only dry run & backup |
| React typecheck and Vite production asset compilation | Yes | PASS | Existing unchanged React UI |
| React browser functional/end-to-end interaction | Yes | NOT VERIFIED | Needs browser automation, screenshots and functional test |
| Wails app, lifecycle and system tray | Tauri available | NOT STARTED | **No desktop build allowed before required gates** |
| macOS ARM64 native Go MCP/Manager runtime | Rust PASS | PASS smoke | Host actual macOS arm64 |
| macOS Intel, Linux, Windows native runtime | Rust incomplete | BLOCKED | Cross-compilation alone is not runtime testing |
| Go vet and race detector | — | PASS current tests | Run with `npm run test:go` |
| Desktop signed/release artifacts | Old Rust/Tauri | BLOCKED | Quality gates not complete; no Wails builds or release |

## Development verification

### Commands

```bash
npm ci
npm run test:go       # Go vet/race, TS typecheck + Vite, Go manager/MCP and fake tunnel E2E
npm run dev:go        # isolated temporary config, local-only manager, browser UI
npm run benchmark:go  # measures Rust release vs Go optimized worker, requires binaries to exist
npm run test:legacy   # reference Node behavior
npm test              # current Rust native baseline
```

`npm run test:go` runs no Wails build and does not access production credentials. Temporary worker binaries are built under the OS temp directory and cleaned afterward. Individual tests can be rerun with `node go/tests/{manager-smoke,hardening-smoke,tunnel-fixture-smoke}.mjs` after Go binaries are built. Temporary fake tunnel credentials are test strings, not real secrets.

### Execution summary on macOS Apple Silicon

| Gate | Status | Details |
| --- | --- | --- |
| Original legacy baseline | PASS | 54/54 tests |
| Original Rust baseline | PASS | 8 unit tests; MCP/hardening/manager smoke all PASS |
| Go config/unit | PASS | Config migration, duplicate validation, atomic save; tunnel SHA fixture |
| Go real MCP tools/manager | PASS | Manager smoke; 2 independent workers and 7 registered tools |
| Go MCP hardening | PASS | Read image/UTF8/large, edit symlink/overlap, shell timeout/output, 8 sessions |
| Go fake tunnel | PASS | Init/run health, readiness, safe key handling, profile cleanup |
| Go vet / unit race | PASS | `go vet ./...`, `go test -race ./...` |
| Go race-instrumented E2E | PASS | Race-compiled manager/worker smoke (one run) |
| React typecheck / static build | PASS | `web/tsconfig.json`, Vite production build (NOT desktop) |
| CLI cross-compilation | PASS | darwin/arm64, darwin/amd64, windows/amd64, linux/amd64, linux/arm64 |
| Windows/Linux/Intel **runtime** | BLOCKED | Requires runners/machines; CI job proposed, not run at time of report |
| Real Go → OpenAI tunnel → ChatGPT | BLOCKED | Credentials/authorization & E2E verification, never simulated |
| Wails desktop feature parity | BLOCKED | No shell/tray build before test gates |
| Full quality gates | **NOT PASS** | Several required features and platform tests unfinished |

These are individual verified test outcomes, **not 100% test coverage**. The Go manager and coding tools still need thorough unit, load, security and failure-injection tests.

## Go vs Rust benchmark (measured, not guessed)

Host: macOS ARM64, 2026-10-11. Executables: Rust release binary; optimized Go build. `go/tests/benchmark.mjs` ran two sequential rounds of 125 MCP requests (alternating text read, ls), 50 warm-up requests each, same filesystem fixture, SDK client and host.

| Run | Startup | p50 MCP | p95 MCP | RSS after work |
| --- | ---: | ---: | ---: | ---: |
| Rust 1 | 675.41 ms | 0.58 ms | 1.07 ms | 6,928 KiB |
| Go 1 | 37.17 ms | 0.61 ms | 1.01 ms | 21,440 KiB |
| Go 2 | 8.48 ms | 0.50 ms | 0.96 ms | 20,976 KiB |
| Rust 2 | 3.76 ms | 0.43 ms | 0.97 ms | 6,960 KiB |

First-launch timings vary dramatically due to cold-start conditions; do not generalize them. Go RSS is **roughly 3× Rust RSS** in this *small* scenario. Further experiments must compare full manager + multiple workers + tunnel under equal workloads, warm/cold conditions and CPU/heap profiles. Performance is subordinate to feature parity and correctness.

## Wails choice — needs explicit gate

As of October 2026, Wails **v3 is beta**, with built-in native cross-platform system tray and window lifecycle APIs. Wails **v2 stable does not have equivalent built-in tray runtime APIs** (the v2 issue tracking this was closed as not planned). System tray is mandatory in AI Local Hub: either use a vetted cross-platform tray implementation with Wails v2 or accept/test the risks of Wails v3 beta. **Do not select or release desktop shell based solely on compilation.** References: <https://github.com/wailsapp/wails/releases>, <https://github.com/wailsapp/wails/issues/4990>, <https://v3.wails.io/features/menus/systray/>.

## Release blockers and next engineering work

1. Differential MCP tests vs TS Pi SDK and Rust implementations (all flags, output and error behavior), `.gitignore`/glob parity.
2. Verified session/queue/resource limits, process group termination/cancellation, worker crash loop, manager restart, port conflicts, permissions and disk-full tests.
3. Repeated benchmark and memory/goroutine leak profile under multi-instance + sessions load. Current Go RSS is materially higher than Rust.
4. Full external tunnel download network tests and real ChatGPT tunnel handshake with authorized credentials in a **separate development instance**, without interrupting the running production app.
5. Headless mode and existing manager lock handover compatibility, CLI option parity, no orphan processes.
6. Browser UI E2E including SSE logs, forms, keyboard navigation, dialog handling, errors, responsive layout and performance.
7. Native runtime verification on macOS Intel, Windows (including PowerShell and path behavior), Linux. CLI cross-compilation is not proof.
8. Decide Wails strategy, implement shell/tray/window lifecycle and test on each OS. **No desktop build until all required development gates pass.**

## Rollback and data protection

- **Do not reset or edit** `~/.config/workspace-tools-mcp/config.json` or the production cache during development.
- No production Rust files have been deleted. Existing `npm start`, `npm test`, Rust binaries, CI release workflow, Tauri resources and `/Applications/AI Local Hub.app` remain available.
- Switch back by stopping only Go development processes/configs and using the unchanged Rust/Tauri run commands. Do not kill the current running Rust processes during migration.
- Before future write-in-place migration: snapshot config using a restrictive private file mode and dry-run the v1/v2 parser; preserve keys; test roundtrip; add a manual rollback procedure.
- Do not stage/commit user secrets or generated release binaries; all Go code is source-only.

**Priority remains full feature parity → correctness → reliability → maintainability → performance → desktop packaging.**
