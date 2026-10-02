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
| `@vibedev/dsh-defaults` | Last layer of every dsh-base profile: no session-log, plugin-inventory, or telemetry uploads to DeepSeek; VibeDev identity in the system prompt | `PROFILE_TEMPLATES` (acp, web, headless, sdk) |
| `@vibedev/dsh-web-defaults` | Last layer of the web/desktop profile: no product analytics, no session-log upload toggle, DeepSeek brand off, VibeDev brand on, Web port 3180 | `PROFILE_TEMPLATES.web` |
| `@vibedev/dsh-client-brand` | VibeDev glyph and name in the sidebar and blank-session hero slots | inserted by `@vibedev/dsh-web-defaults` |
| `@vibedev/dsh-account` | Account provider for `ctx.deepseekAccount`: `/vibedev-link` authorization code + PKCE, app tokens with rotating refresh tokens (gateway spec `DSH-GATEWAY-APP-TOKEN-SPEC-1002.md`) | Not yet: replaces the `deepseek-account` row once the gateway serves app tokens |

## Changes to upstream files

| File | Change | Why | Upstreamable |
|---|---|---|---|
| `packages/boot/app-boot/src/profile.ts` | Base-backed templates end with `@vibedev/dsh-defaults`; `web` also with `@vibedev/dsh-web-defaults` | VibeDev defaults load in every profile | No |
| `apps/cli/package.json` | Depends on `@vibedev/dsh-defaults` and `@vibedev/dsh-web-defaults` | Bundles resolve from the installation | No |
| `tsconfig.host.json` | References the host-side `packages/vibedev/*` packages | Host typecheck and build | No |
| `tsconfig.client.json` | References `packages/vibedev/client-brand` | Client typecheck and build | No |
| `scripts/check-workspace-constraints.ts` | `packages/vibedev/*` are not npm release members: they must use the `@vibedev` scope, must not be private, and omit `publishConfig` | Packed into the app, never published | No |
| `scripts/release/families.ts` | The dsh family accepts `@vibedev/*` names | `release:pack` (and so Desktop packaging) includes the VibeDev packages; we never run `release:publish` | No |
| `apps/desktop/src/main.ts` | `DSH_HOME` defaults to `~/.vibedev-app`; About name "VibeDev"; OS scheme `vibedev-app://` | Run alongside an installed DeepSeek Harness; brand | Partly: a build-time home/scheme option |
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
| Tests and expected outputs under `apps/desktop/tests`, `apps/web/tests`, `packages/api/workspace-controller/tests`, `packages/llm/*/tests`, `packages/boot/app-boot/tests`, `packages/client/ui-conversation/tests`, `packages/client/ui-plugin-manager/tests`, `packages/client/ui-settings-models/tests`, `scripts/*.spec.ts` | Follow the changes above | — | No |
