---
description: "VibeDev product composition for Web and Desktop."
kind: "package-bundle"
---

# @vibedev/dsh-web-defaults

English | [中文](README.zh.md)

## Summary

This bundle follows `dsh-web-app`: it disables DeepSeek product analytics and branding, loads the VibeDev browser brand, builds in the VibeDev Ecosystem, places the DeepSeek account in the secondary sidebar entry and configures the Web server.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## Configuration and ownership

[cordis.patch.yml](cordis.patch.yml) owns the complete patched rows, including the Web persona and current-profile plugin installation guidance.

The VibeDev Ecosystem (`@vibedev-si/dsh-ecosystem`, pinned exactly here and in the CLI install anchor) is inserted with its own row id `vibedev-center` and `config: { official: true }`: the Plugins page lists it in the Official group and opening its card opens the ecosystem, which reports that it updates with the app. The Desktop Host names it among its installation plugins, so a copy a profile installed earlier never loads beside it.

<a id="model-experience"></a>
## Model Experience

### Web persona and plugin guidance

#### What the model sees

The system-prompt consumer renders `personaPrefix` with the selected model; `personaSuffix` is the package-owned plugin guidance. Since `dsh-v0.2.1-alpha.2` the working directory is no longer a prompt variable: the `working_directory` tool reports it.

##### Package-owned prompt text

```markdown
You are a coding agent running in VibeDev, powered by the {{model}} model.

Plugins in VibeDev are installed, enabled, and removed on the Plugins page (Plugins → Add plugin), which installs into the profile this app runs. When the user asks to install a plugin, send them there with the package name. The command-line equivalent, when `vibedev-app` is on PATH, is `vibedev-app plugin --profile desktop add <package>` for the desktop app, which must be fully quit first. Plugin READMEs written for DeepSeek Harness say `dsh plugin --profile web add <package>`: never run that for VibeDev. A `dsh` command on PATH belongs to the separate DeepSeek Harness app, and a `web` profile is not the one the VibeDev desktop app loads.
```

#### Token effect

The persona and installation guidance add fixed text; the rendered model name determines the remaining input tokens.

#### KV Cache effect

Changes to the persona, model or directory can invalidate request-prefix reuse; browser branding and account-menu geometry do not enter model input.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- This layer requires the Web composition. It does not configure headless profiles or native desktop installer branding.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
