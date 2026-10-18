---
name: reference-updater-signing
description: Where the desktop updater signing key lives and how release versions must line up (tag vs package.json) for the Tauri updater
metadata:
  type: reference
---

- Desktop updater minisign key pair: `~/.tauri/ai-local-hub-updater.key(.pub)` on the maintainer Mac, key id 50BAD47AD09E6E42. It matches `plugins.updater.pubkey` in `desktop/src-tauri/tauri.conf.json`. Repo secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` were created 2026-10-18.
- Release convention (not enforced by CI as of 2026-10-18): tag `vX.Y.Z` must equal the root `package.json` version. Signatures embed the package.json version, and `scripts/updater-manifest.mjs` takes `latest.json` version from the tag. A mismatch makes the plugin reject every update with SignedVersionMismatch.
- Plugin crate sources for verification: `~/.cargo/registry/src/*/tauri-plugin-updater-2.14.0/src/updater.rs` (the locked version is 2.14.0, not 2.12).

Related: [[desktop-auto-update]]
