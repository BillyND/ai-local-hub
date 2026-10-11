# AI Local Hub

**Native Rust MCP hub for ChatGPT and other AI clients.** The AI client remains the agent; AI Local Hub gives it coding tools on your own computer. No local AI model is required.

The **manager, MCP protocol server, coding-tool execution, instance supervision, config/API and OpenAI tunnel orchestration are written in Rust**. The desktop container is Tauri 2 / Rust. The visual UI is React/Vite and is served as static files; it does not run a Node/Bun application server.

## Build and run (from the repository)

Requirements: Rust toolchain (stable), Node.js/npm **only to compile the React UI and invoke build scripts**, and a ChatGPT workspace with OpenAI Secure MCP Tunnel access for remote connectivity.

```bash
npm ci
npm run build
npm start
```

The manager opens a local UI (default port 4747). The UI lets you create, edit, start, stop and delete independent instances, browse workspace folders, view live logs, copy local MCP addresses, and start or stop every instance.

Each instance has its own workspace, Tunnel ID, runtime API key, native Rust worker, local MCP HTTP endpoint and (when enabled) official OpenAI tunnel-client process. The hub does **not** embed Bun or Node.js in the app's runtime.

```bash
npm start -- --no-open          # print URL instead of opening browser
npm start -- --port 4800        # fixed manager port
npm start -- --local-only       # test MCP tools without a tunnel
npm start -- --headless         # start all saved instances, no web UI
npm start -- --headless --instance work
npm start -- --reset            # remove the stored config
npm run dev:web                 # Vite UI development (manager must also be running)
```

To run without the small npm launcher, use `rust/runtime/target/release/ai-local-hub-manager` directly. It picks up the sibling native worker binary. On Windows the filenames end in `.exe`.

## Desktop app: macOS / Windows / Linux

The desktop uses a Tauri 2 shell and the same static React UI. It embeds two native executables: `ai-local-hub-manager` and `ai-local-hub-runtime`. No Bun/Node executable is staged.

```bash
npm run desktop:setup           # install the Tauri build CLI
npm run desktop:build           # build native Rust + static UI + installers
npm run desktop:dev             # launch the desktop in development mode
```

Desktop packaging assets are staged by `scripts/stage-rust-desktop.mjs` and built by `desktop/src-tauri/tauri.conf.json`. macOS builds produce an app/DMG, subject to the machine's signing credentials. Build workflows currently target macOS Apple Silicon and Intel; Windows/Linux source paths exist, but require native platform verification.

The app reuses the existing manager lock when one is already running. On macOS and Windows, closing the window hides it while the manager continues under the tray/menu-bar icon; **Quit** stops workers and tunnels. A desktop-launched manager also observes stdin EOF so it does not outlive the desktop host.

## Connecting ChatGPT

1. In [OpenAI Tunnel settings](https://platform.openai.com/settings/organization/tunnels), create or select a tunnel for your target ChatGPT workspace.
2. Create a runtime API key with **Tunnels Read + Use** permission (not an admin key).
3. Open AI Local Hub, add an instance with workspace folder, Tunnel ID and API key, and click **Start**.
4. The hub downloads the **official** `openai/tunnel-client` binary, verifies the published SHA256 checksum, prepares a private runtime profile and waits for both `/healthz` and `/readyz`.
5. In ChatGPT, add a custom MCP plugin using **Tunnel**, select the same Tunnel ID and review the tool access. Refresh the plugin after schema changes.

The remote handshake depends on OpenAI authorization and configuration. Native `--local-only` tests do not validate a remote tunnel.

## Available MCP tools

| Tool | Behavior |
| --- | --- |
| `read` | UTF-8 text, line `offset`/`limit`, PNG/JPEG/GIF/WebP/BMP as MCP image content |
| `bash` | Execute shell commands under the instance workspace; stdout/stderr, exit code, timeout |
| `edit` | Exact, unique, nonoverlapping string replacements; validates before writing |
| `write` | Write/create a file and parent folders |
| `grep` | Regex/literal content search, `.gitignore`, glob filter and context |
| `find` | Glob path search, `.gitignore` |
| `ls` | Sorted directory listing |

Relative paths use the configured workspace as the working directory. **It is not a sandbox.** Absolute paths and arbitrary shell access are intentionally permitted; connect only trusted AI clients.

This is a **native implementation** with equivalent tool categories; not a byte-for-byte implementation of the Pi SDK. Some less-common Pi behavior (for example automatic image resizing, shell progress notifications, certain output formatting and concurrency semantics) still needs parity testing before treating the migration as fully equivalent. See [migration status](docs/RUST-MIGRATION.md).

## Configuration, privacy and security

Existing saved settings and legacy environment variables remain supported:

- Config: `~/.config/workspace-tools-mcp/config.json`; override with `WORKSPACE_TOOLS_CONFIG_FILE`.
- Cache: `~/.cache/workspace-tools-mcp`; override with `WORKSPACE_TOOLS_CACHE_DIR`.
- Legacy config v1 is read/migrated into v2 in memory, keeping the old instance.
- New configs are saved atomically and use `0600` permissions on Unix; API keys are **write-only in the UI**.
- UI listens only on `127.0.0.1`, requires a random launch token exchanged for a `SameSite=Strict`, `HttpOnly` cookie, checks Host and Origin, and returns security headers.
- The worker removes its OpenAI API key from the environment before shell tools run. The official tunnel-client gets the key through a scoped environment variable, not a command-line argument.
- Logs are kept in memory (last 1,000 per instance) and redact the configured key.

Tunnel archive checksum verification protects against accidental/corrupted downloads, not a cryptographic publisher signature. Restrict key permissions and treat any client with full shell access as highly privileged.

## Verification

```bash
npm run build             # Rust release executables + React UI
npm test                  # Rust MCP smoke, Rust manager/API integration, cargo tests
node scripts/verify-desktop-build.mjs  # verify native app sidecars and macOS DMG
```

The native integration tests cover MCP initialize, all seven tools, errors, command stdout/stderr, timeout, truncation, large files, symlink edits, Host/Origin validation, and full-access absolute paths. The manager test covers auth, config CRUD, failed-save rollback, two isolated workers, worker stop, native MCP and shutdown. Additional Rust unit tests cover token/host validation, config migration, shared process limits and UTF-8 truncation.

A Tauri release compilation can be checked with `cd desktop && ./node_modules/.bin/tauri build --no-bundle` after assets are staged. Test signed installers, startup/shutdown, GitHub macOS x64 cross-build, Windows/Linux shell behavior and **real OpenAI tunnel connection** on the respective platforms before a broad release.

## Repository layout

```text
rust/runtime/
  src/bin/ai-local-hub-manager.rs  # native manager CLI
  src/manager_*.rs                 # state/config/HTTP/SSE
  src/main.rs                      # native MCP worker
  src/tools.rs                     # Rust coding tools
  src/tunnel*.rs                   # official tunnel-client orchestration and verification
  tests/                           # end-to-end tests from a real MCP SDK client
desktop/src-tauri/                 # Tauri 2 native desktop shell
web/                               # React UI and static assets
scripts/                           # native build, staging and launch scripts
```

## Design principles

Favor straightforward Rust async I/O with Tokio, separate failure domains for workers, bounded output, secure secret handling, a stable HTTP contract for the UI and a standard MCP transport for AI clients. Optimize based on repeatable benchmarks, not the assumption that every Rust rewrite will always be faster. Existing React components are deliberately preserved until profiling justifies changes.
