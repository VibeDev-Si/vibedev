# FORK-DELTA — VibeDev on DeepSeek Harness

This repository is VibeDev's fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).
`main` is an upstream release tag plus the VibeDev changes recorded here. The plan behind it lives outside the repo in
`C:\vdp-tools\coordination\DSH-FORK-PLAN-1002.md`.

- **Upstream base:** `dsh-v0.2.0-rc.2` (`639ed01539`). Remote `upstream` tracks deepseek-ai/deepseek-harness.
- **Keep upstream identities that plugins depend on:** the `@deepseek-ai/*` package names, the runtime version, `DSH_*`
  variables, bundle row ids, the session format, and project-local `.dsh/` directories.
- **Put VibeDev features in new packages** under `packages/vibedev/*`: `@vibedev/*` packages packed into the app with the
  dsh release family and never published to npm. They carry the dsh family version (`0.2.0-rc.2` now), so an upstream merge
  that moves the root version must move theirs too, or `release:pack` refuses the family.
- **Override upstream bundle rows from our bundles.** Never edit `packages/bundle/*/cordis.patch.yml`; upstream adds rows to
  them in almost every release.
- **Every change to an upstream file gets a row below,** so each upstream merge can re-check it.

## VibeDev identity

| Identity | Upstream | VibeDev | Where |
|---|---|---|---|
| Install name (exe, install dir, Start menu, uninstall entry) | DeepSeek Harness | VibeDev Next (while the current VibeDev Studio still installs as "VibeDev") | `electron-builder-config.mjs` |
| Name shown in the app | DeepSeek Harness | VibeDev | locale files, About panel, client title |
| Harness home | `~/.dsh` | `~/.vibedev-app` (default for `DSH_HOME`; an explicit `DSH_HOME` wins) | `apps/desktop/src/main.ts`, CLI shims |
| Desktop Host port (also the sign-in callback port) | 19387 | 19487 | `apps/desktop-host/src/index.ts` |
| Web port (`vibedev-app web`) | 3080 | 3180 | `@vibedev/dsh-web-defaults` |
| OS URL scheme | `dsh://` | `vibedev-app://` | `main.ts`, `electron-builder-config.mjs` |
| Electron package name (userData, updater cache) | `@deepseek-ai/dsh-desktop` | `@vibedev/app-desktop` | `electron-builder-config.mjs` `extraMetadata.name` |
| Public command | `dsh` | `vibedev-app` | CLI shims, `prepare-cli.ts`, command management |
| Default workspace | `Documents/deepseek-harness` | `Documents/VibeDev` | `default-directory.ts` |
| Model request User-Agent | `deepseek-harness/<v>` | `vibedev-app/<v>` | `packages/llm/llm/src/attribution.ts` |
| App id (packaging env `DSH_DESKTOP_APP_ID`) | `com.deepseek.harness` | `cn.bigopen.vibedev.app` | packaging environment |

## VibeDev packages (`packages/vibedev/*`)

| Package | Role | Wired in |
|---|---|---|
| `@vibedev/dsh-defaults` | Last layer of every dsh-base profile: no session-log, plugin-inventory, or telemetry uploads to DeepSeek; VibeDev identity in the system prompt; the VibeDev account and gateway models replace the DeepSeek account and its models; new sessions default to the gateway's `deepseek-v4-flash` (interim choice); the DeepSeek API-key route (`llm-deepseek`) is off; web search goes through the gateway (`web-search-deepseek` off, which also hides its DeepSeek-key settings page; `web.searchProvider: vibedev-gateway`) | `PROFILE_TEMPLATES` (acp, web, headless, sdk) |
| `@vibedev/dsh-web-defaults` | Last layer of the web/desktop profile: no product analytics, no session-log upload toggle, DeepSeek brand off, VibeDev brand on, Web port 3180; the web persona restated with the VibeDev identity and how plugins are installed in VibeDev (never the `dsh` command) | `PROFILE_TEMPLATES.web` |
| `@vibedev/dsh-client-brand` | VibeDev glyph and name in the sidebar and blank-session hero slots | inserted by `@vibedev/dsh-web-defaults` |
| `@vibedev/dsh-account` | Account provider for `ctx.deepseekAccount`: `/vibedev-link` authorization code + PKCE, app tokens with rotating refresh tokens (gateway spec `DSH-GATEWAY-APP-TOKEN-SPEC-1002.md`) | Inserted by `@vibedev/dsh-defaults` as `vibedev-account`; `deepseek-account` is disabled |
| `@vibedev/dsh-llm-gateway` | The gateway's chat models on the `deepseek-account` channel: catalog from `/v1/models`, one route over Messages (Claude), Responses (GPT, Grok) and Chat Completions (the rest), catalog reasoning levels, Bearer access token (or a signature-exempt development key from `VIBEDEV_GATEWAY_API_KEY`), session affinity, 402 → top-up and 401 → token rejected. `context.ts`, `stream.ts`, `replay.ts` are copies of `@deepseek-ai/dsh-llm-pi-ai`'s and must follow upstream | Inserted by `@vibedev/dsh-defaults` as `llm-vibedev-gateway`; `llm-deepseek-account` is disabled; registers the route as a configurable provider so the Models page shows the VibeDev account row after sign-in |
| `@vibedev/dsh-web-search-gateway` | Web search provider `vibedev-gateway` over the gateway's `POST /v1/vibedev/web-search`, with the gateway models' credential (account access token, or the development key from `VIBEDEV_GATEWAY_API_KEY`): searches go out one at a time, 429/503 wait out `Retry-After`, a 401 refreshes the token once, 402 asks for a top-up; instant answers become the result summary | Inserted by `@vibedev/dsh-defaults` as `web-search-vibedev` |

## Changes to upstream files

| File | Change | Why | Upstreamable |
|---|---|---|---|
| `packages/boot/app-boot/src/profile.ts` | Base-backed templates end with `@vibedev/dsh-defaults`; `web` also with `@vibedev/dsh-web-defaults` | VibeDev defaults load in every profile | No |
| `apps/cli/package.json` | Depends on `@vibedev/dsh-defaults` and `@vibedev/dsh-web-defaults` | Bundles resolve from the installation | No |
| `tsconfig.host.json` | References the host-side `packages/vibedev/*` packages | Host typecheck and build | No |
| `tsconfig.client.json` | References `packages/vibedev/client-brand` | Client typecheck and build | No |
| `scripts/check-workspace-constraints.ts` | `packages/vibedev/*` are not npm release members: they must use the `@vibedev` scope, must not be private, and omit `publishConfig` | Packed into the app, never published | No |
| `scripts/release/families.ts` | The dsh family accepts `@vibedev/*` names | `release:pack` (and so Desktop packaging) includes the VibeDev packages; we never run `release:publish` | No |
| `apps/desktop/src/main.ts` | `DSH_HOME` defaults to `~/.vibedev-app`; About name "VibeDev"; OS scheme `vibedev-app://`; while preparing each Host start, copies the sessions of an installed DeepSeek Harness (`~/.dsh`) into the VibeDev home with the new `src/vibedev-dsh-import.ts` (`VIBEDEV_DSH_IMPORT=0` turns it off). The importer reads upstream's session, attachment, projection-cache and workspace-store layouts directly, so an upstream merge that changes any of them must update it | Run alongside an installed DeepSeek Harness; brand; people who switch keep their history | Partly: a build-time home/scheme option |
| `apps/desktop-host/src/index.ts` | Host port 19487 | Run alongside an installed DeepSeek Harness | Partly: a configurable port |
| `apps/desktop/scripts/electron-builder-config.mjs` | Product name, scheme, artifact names, `extraMetadata.name`; one macOS `extendInfo` | Identity; upstream declared `extendInfo` twice, so `CFBundleLocalizations` was dropped | The `extendInfo` fix: yes |
| `apps/desktop/scripts/package-macos.ts`, `package-target.ts`, `smoke-packaged-runtime.ts` | Packaged app path `VibeDev Next.app/.exe` | Follows the product name | No |
| `apps/desktop/scripts/package-macos.ts`, `desktop-upload-plan.ts`, `desktop-build-version-discovery.ts`, `installed-update-distribution.ts` | Artifact prefix `vibedev-next-` | Every copy of the artifact name must match `artifactName` | Partly: one shared artifact-prefix constant |
| `apps/desktop/scripts/development-app.ts` | macOS dev bundle URL scheme and bundle id | Follows the scheme and app id | No |
| `apps/desktop/.env.windows.example`, `.env.macos.example` | `DSH_DESKTOP_APP_ID=cn.bigopen.vibedev.app` | Packaging never reuses DeepSeek's app id | No |
| `apps/desktop/cli/dsh` → `vibedev-app`, `dsh.cmd` → `vibedev-app.cmd` | Renamed; launch `VibeDev Next`; default `DSH_HOME` | Own command; same home as the Desktop app | No |
| `apps/desktop/scripts/prepare-cli.ts`, `src/command-management.ts`, `src/command-manager-entry.ts`, `scripts/command-path.ps1` | Command name `vibedev-app`; registry key and mutex `VibeDevApp` | Own command and PATH ownership | No |
| `apps/desktop/src/locale.ts` | Product name, command name, address-in-use text, welcome tagline | Brand; the tagline is placeholder copy awaiting the user's wording | No |
| `packages/api/workspace-controller/src/default-directory.ts` | `Documents/VibeDev` | Brand | No |
| `packages/client/ui-conversation/src/client/locales.ts` | Blank-session headline "用 AI 编码与创作 / Code and create with AI" instead of DeepSeek's slogan | Brand; placeholder copy awaiting the user's wording | No |
| `packages/client/ui-settings-models/src/client/locales.ts` | First-run preview notice rewritten for VibeDev | Brand; placeholder copy awaiting the user's wording | No |
| `packages/llm/llm/src/attribution.ts` | `APP_IDENTITY` = `vibedev-app` + `https://vibedev.jzsaas.com` | Provider requests identify VibeDev | No |
| `scripts/client-build-environment.ts` | Official build title "VibeDev" | Brand; the official brand row is disabled by `@vibedev/dsh-web-defaults` | No |
| `packages/client/ui-plugin-manager/src/client/` (`slot-contract.ts`, `navigation-store.ts`, `manager-store.ts`, `PluginManagerPage.tsx`, `index.ts`, `locales.ts`) | New root slot `plugins.add.browse`: when a plugin market fills it, Add plugin opens it as a page that keeps "Install by name or address" for the dialog; `openInstall(prefill)` on the page face and on `ctx.pluginNavigation` fills in the spec and the registry (a prefilled registry survives the Host's registry answer and is not remembered as the last used) | The plugin market lives inside Plugins → Add plugin (our dsh-market fork fills the slot) | Yes: a generic market slot |
| `apps/desktop/resources/icon*.svg`, `icon*.png`, `tray-windows.ico`; `apps/desktop/installer/assets/*.png`; `apps/desktop/renderer/assets/welcome-brand.svg`; `apps/web/public/favicon*.svg`; `packages/client/ui-chat/src/client/chat/running-whale@2x.png`; `packages/client/ui-settings-account/src/client/assets/onboarding-{welcome,recharge}*.png` | VibeDev app icon (VibeDev Studio's chevron V on its dark tile), installer and welcome lockups with a Montserrat "VibeDev" wordmark, chevron running animation, interim first-run artwork (the tile in a cyan glow) until the account flow gets VibeDev screens; all generated by `scripts/vibedev/brand-assets.mjs` (tray icon by the existing `render:tray-icon`) | Brand | No |
| `packages/client/ui-chat/src/client/chat/RunningWhaleTail.tsx` | Static rest path is the VibeDev chevrons | Matches the new running animation | No |
| `apps/web/public/manifest.webmanifest` | Name and short name VibeDev | Brand | No |
| `apps/desktop/installer/strings.nsh`, `apps/desktop/installer/extract-report.h` | Product name in installer messages and the extraction report | Brand | No |
| `apps/desktop/electron-builder.config.d.mts` | Protocol type follows the config (`VibeDev`, `vibedev-app`) | Matches `electron-builder-config.mjs` | No |
| Client copy: `packages/client/locale/src/locales/{en,zh}.ts`, `ui-agent-preset`, `ui-conversation`, `ui-model-selection`, `ui-plugin-manager`, `ui-settings-models`, `ui-settings-account` (incl. `locales/onboarding.ts`), `ui-sidebar-documentpreview/src/client/office`, `ui-chat` (`深度求索中` → `工作中`), `packages/experimental/client-ui-voice-input` | Product name VibeDev and the `vibedev-app` command; the account copy and the account channel's labels (`ui-model-selection` `provider.account`, `ui-settings-models` `deepSeekAccount`) name the VibeDev account; copy about DeepSeek models and DeepSeek search, and the DeepSeek official API-key dialog, stays | Brand; the account is VibeDev's | No |
| `packages/bundle/web-app/src/index.ts`, `packages/boot/app-boot/src/index.ts` | Model-visible: the GUI is the VibeDev Web GUI; the source note names VibeDev and explains the `@deepseek-ai/dsh-*` package names | The model calls the product VibeDev | No |
| `packages/subagent/subagent-codex/src/wire.ts` | Codex app-server `clientInfo` is `vibedev-app` / VibeDev | Same identity as the model User-Agent | No |
| `packages/experimental/inspector/src/worker/bridge/endpoint.ts` | Inspector target title "VibeDev Host" | Brand | No |
| `packages/client/ui-settings-models/src/client/` (`store.ts`, `ModelsSection.tsx`, `ProviderEditor.tsx`, `locales.ts`) | The account row keeps the account channel's models from the session catalog (`accountModels`) and its card lists them read-only instead of the editable DeepSeek model list | The gateway owns the VibeDev model list; a user-edited list would be ignored | No |
| Tests and expected outputs under `apps/desktop/tests`, `apps/web/tests`, `packages/api/workspace-controller/tests`, `packages/llm/*/tests`, `packages/boot/app-boot/tests`, `packages/client/ui-chat/tests`, `packages/client/ui-model-selection/tests`, `packages/client/ui-conversation/tests`, `packages/client/ui-plugin-manager/tests`, `packages/client/ui-settings-account/tests`, `packages/client/ui-settings-models/tests`, `packages/bundle/web-app/tests`, `packages/subagent/subagent-codex/tests`, `scripts/*.spec.ts` | Follow the changes above | — | No |
