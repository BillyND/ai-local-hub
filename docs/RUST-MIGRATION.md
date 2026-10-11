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
