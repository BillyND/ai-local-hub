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

The manager opens a local UI (default port 4747). The UI lets you create, edit, start, stop and delete independent instances, browse workspace folders, choose optional MCP tool groups, view live logs, copy local MCP addresses, and start or stop every instance.

Each instance has its own workspace, Tunnel ID, runtime API key, selected tool groups, native Rust worker, local MCP HTTP endpoint and (when enabled) official OpenAI tunnel-client process. The default groups are `core`, `ast`, `lsp`, and `ls`; `core` contains `read`, `write`, `edit`, `grep`, `glob`, `bash`, `wait`, and `kill_job`. The hub does **not** embed Bun or Node.js in the app's runtime.

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

Desktop packaging assets are staged by `scripts/stage-rust-desktop.mjs` and built by `desktop/src-tauri/tauri.conf.json`. macOS builds produce an app/DMG, Windows builds produce MSI/NSIS installers, and Linux builds produce AppImage/DEB packages. `.github/workflows/desktop.yml` verifies all native binaries and creates a GitHub release with all platform installers for each `v*` tag. Builds are unsigned by default; platform signing credentials can be added to the workflow.

The app reuses the existing manager lock when one is already running. On macOS and Windows, closing the window hides it while the manager continues under the tray/menu-bar icon; **Quit** stops workers and tunnels. A desktop-launched manager also observes stdin EOF so it does not outlive the desktop host.

### Automatic updates

The desktop app checks the latest GitHub release 10 seconds after launch and every 6 hours after that, then shows a system notification and an in-app banner when a newer version exists. The **Updates** button in the header shows the installed version and the **Install updates automatically** switch (on by default):

- **On:** the app downloads the update, verifies its signature, installs it and restarts by itself.
- **Off:** nothing installs until **Update and restart** is clicked in the banner.

Instances that were running or starting before an update restart start again in the new version. A failed download or install shows in the banner with **Try again** and leaves the current version running; that version is not retried automatically until the app restarts. Version 0.4.8 and older have no updater, so install the first version that has it by hand. On Linux, AppImage and DEB installs both update (DEB asks for an administrator password through `pkexec`). The UI served to a regular browser (`npm start`) has no update controls.

Releases are signed for the updater by `.github/workflows/desktop.yml`: the `bundle` job compiles without the key, then packages with `desktop/src-tauri/tauri.updater.conf.json` and the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets, and the `release` job publishes `latest.json` (written by `scripts/updater-manifest.mjs`, which fails unless the tag is `v` plus the `package.json` version). The public key in `desktop/src-tauri/tauri.conf.json` must match that private key: if the private key is lost, installed apps cannot accept any later update. Local builds do not create update packages and need no key.

## Connecting ChatGPT

1. In [OpenAI Tunnel settings](https://platform.openai.com/settings/organization/tunnels), create or select a tunnel for your target ChatGPT workspace.
2. Create a runtime API key with **Tunnels Read + Use** permission (not an admin key).
3. Open AI Local Hub, add an instance with workspace folder, Tunnel ID and API key, and click **Start**.
4. The hub downloads the **official** `openai/tunnel-client` binary, verifies the published SHA256 checksum, prepares a private runtime profile and waits for both `/healthz` and `/readyz`.
5. In ChatGPT, add a custom MCP plugin using **Tunnel**, select the same Tunnel ID and review the tool access. Refresh the plugin after schema changes.

The remote handshake depends on OpenAI authorization and configuration. Native `--local-only` tests do not validate a remote tunnel.

## Available MCP tools
Tool groups are configured per instance. `core` is always enabled; `ast`, `lsp`, and `ls` are optional. Changing the selection requires restarting the instance so the MCP tool list is rebuilt.


| Tool | Behavior |
| --- | --- |
| `read` | oh-my-pi style: `path` with selectors (`f.rs:50-80`, `:-5`, `:3,9-12`, `:raw`); text rows `N:text` under a `[path#TAG]` snapshot header; directories; PNG/JPEG/GIF/WebP/BMP as MCP image content |
| `bash` | oh-my-pi style: `command`, `cwd`, `timeout` (0 = no deadline, else clamped 1-3600, default 300), `async`; merged stdout/stderr, `Wall time:` line, `Command exited with code N`; head+tail truncation with the full output at `artifact://<id>` (readable with `read`); commands still running 60s in (or 1s before `timeout`) move to background job `bg_N` |
| `ast_grep` | oh-my-pi style structural search (ast-grep, tree-sitter): one pattern per call, `$NAME` / `$$$NAME` metavariables, `*N:text` rows with `meta:` captures under `file#TAG` headers, 50 matches per page; works for the 18 natively linked languages |
| `ast_edit` | Structural rewrites (`ops: [{pat, out}]`, `paths`) staged as a diff proposal; nothing is written until `resolve` (apply) or `reject` (discard) |
| `lsp` | oh-my-pi style language-server tool (`status`, `diagnostics`, `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `rename`, `rename_file`, `code_actions`, `capabilities`, `request`, `reload`): servers are discovered from omp's default table (55 languages) plus `lsp.json`, binaries from the project (`node_modules/.bin`, `.venv`, ...) or `PATH`; you install the language servers yourself |
| `wait` | Blocks on background jobs (50s cap, then a still-running snapshot); settled job results are also appended to the next tool result |
| `kill_job` | Cancels a background job (`bg_N`) |
| `edit` | oh-my-pi **hashline** patches (`[path#TAG]` + `PUT`/`CUT`/`REM`/`MV`), stale-tag recovery, block ops, atomic apply; engine vendored from oh-my-pi |
| `write` | Write/create a file and parent folders; returns a fresh `[path#TAG]`; strips pasted hashline prefixes; refuses generated files |
| `grep` | oh-my-pi style: `path` is a `;`-separated list of files/dirs/globs (bare `*.ts` recurses), `case`, `gitignore`, `skip` (20 files/page), file selectors `f.ts:50-100`; Rust regex with look-around fallback; grouped `*N:text` rows under `file#TAG` headers |
| `glob` | oh-my-pi style path/pattern search: `;`-separated list, `hidden`, `gitignore`, `limit` (max 200), newest first, grouped by directory |
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
rust/vendor/omp/                   # vendored oh-my-pi crates (MIT): hashline edit engine, see NOTICE.md
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
