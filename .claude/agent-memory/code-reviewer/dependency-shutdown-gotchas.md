---
name: dependency-shutdown-gotchas
description: Verified shutdown/quit behaviour of rmcp 3.5.1, tokio, and Tauri 2.12/tao 0.37 that review of quit/cancel code must account for
metadata:
  type: project
---

Verified against registry sources during the 2026-10-18 hang/leak hardening review.

- rmcp 3.5.1 `StreamableHttpServerConfig::with_cancellation_token` only ends SSE streams. Stateful
  sessions run `serve_server` with `CancellationToken::new()`, and `LocalSessionManager::create_session`
  uses `WorkerTransport::spawn` with its own fresh token. So cancelling that token does NOT close sessions
  or cancel the per-call `ct` that tools receive.
- rmcp `serve_negotiated_request_directly` (per-request protocol negotiation) builds a fresh handler for
  each request. Per-session `Drop` logic then runs after every such request.
- tokio `Runtime::drop` (including `#[tokio::main]`) waits forever for `spawn_blocking` work, and
  `tokio::io::stdin()` reads on a blocking thread that cannot be cancelled. A worker that shuts down
  while its stdin pipe is still open hangs at exit.
- Tauri 2.12: `ExitRequestApi::prevent_exit` is ignored for `RESTART_EXIT_CODE` (`request_restart`).
  On macOS, Cmd+Q from the default menu (`PredefinedMenuItem::quit`) and logout go to
  `applicationWillTerminate`, which becomes `LoopDestroyed` and then `RunEvent::Exit` with NO
  `ExitRequested`.

**Why:** In each case the code looks right but the dependency does something different. Quit and cancel
paths are easy to get wrong because of this.
**How to apply:** In reviews of worker shutdown, MCP session lifecycle, or desktop quit/restart code,
check that the code does not depend on the behaviours ruled out above.
