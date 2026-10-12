---
kind: upgrade-guide
description: "VibeDev uses the American API by default and requires a new login instead of restoring historical unscoped gateway state."
---

# VibeDev gateway and account state

English | [中文](guide.zh.md)

## Change

VibeDev defaults to `https://api.vibedev.studio`. The account plugin uses a separate credential key and state directory for every canonical gateway origin. Historical unmarked login files, credential records and media tasks remain on disk but are not imported or restored. Old video, audio and upload tasks are not resubmitted. DeepSeek accounts, local chats, workspaces and historical media URLs are unchanged. The optional `us-candidate.patch.yml` export is removed.

In VibeDev, only the VibeDev primary account controls the welcome page. Signing out of DeepSeek or its session expiring keeps the workspace open; signing out of VibeDev returns to its welcome page even while DeepSeek or another provider key remains configured. In official DSH, installing the plugin as a secondary account retains the official DeepSeek entry policy.

The desktop Host uses its shipped VibeDev component even if an older standalone copy remains in the profile. Its redundant standalone bundle no longer replaces the application's primary-account configuration. This is a runtime selection rule: no installed files, manifest, lockfile, login records, or unrelated plugins are removed or rewritten. Explicit user configuration and disable choices still apply.

## Migration

1. Review any `dsh-vibedev` row in `$DSH_HOME/cordis.patch.yml` and `$DSH_HOME/profiles/desktop/cordis.patch.yml`. Remove an obsolete `gatewayOrigin` override to inherit the default, or set it explicitly to `https://api.vibedev.studio`; preserve other settings. Use `apiKeyEnv: ''` for account mode. Remove references to the retired candidate overlay.
2. Restart the application and sign in from the sidebar or Settings → VibeDev account. Authentication retains PKCE S256, state and the random localhost callback; do not replace that callback with a storage domain. The model catalog appears only after login.
3. Leave historical state intact. Do not copy old task identifiers or unmarked grants into the new origin namespace. Signed upload and download URLs remain exactly as returned by the API; do not rewrite old media links.
4. Confirm that login links and authenticated catalog/search requests use the American API. A server 503 remains a refusal; it must not trigger another gateway or a new media generation.
5. The login webpage also needs the gateway's public `api_base_url` and recharge URL set to the American API. Changing desktop defaults cannot change configuration served by the gateway's webpage.
