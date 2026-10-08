---
description: "VibeDev branding for browser sidebar and conversation views."
kind: "package-reference"
---

# @vibedev/dsh-client-brand

English | [中文](README.zh.md)

## Summary

This browser plugin fills the sidebar brand mark and name and the empty-conversation hero mark. Its Host entry contributes no runtime service.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## Configuration and ownership

Registrations follow their declaring slots and are removed when the plugin is disposed.

<a id="model-experience"></a>
## Model Experience

### Browser presentation

#### What the model sees

The model receives no text from `sidebar.brand.mark`, `sidebar.brand.name` or `conversation.hero.brand.mark`; these slots render browser components.

#### Token effect

Brand rendering adds no input or output tokens.

#### KV Cache effect

Browser component state is independent of model context and prefix reuse.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Branding covers the declared slots only. Desktop installer identity and native window assets are owned by the desktop application.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
