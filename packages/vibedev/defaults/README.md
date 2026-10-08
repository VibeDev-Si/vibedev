---
description: "VibeDev product composition shared by the shipped profiles."
kind: "package-bundle"
---

# @vibedev/dsh-defaults

English | [中文](README.zh.md)

## Summary

This bundle applies the product layer over `dsh-base`: VibeDev identity, disabled DeepSeek telemetry, the VibeDev account plugin and gateway model/search defaults. Official DeepSeek account rows remain available as the second account.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## Configuration and ownership

[cordis.patch.yml](cordis.patch.yml) owns the row configuration. Profile and home patches can override it; the account plugin is an npm dependency pinned to an exact version.

<a id="model-experience"></a>
## Model Experience

### Product identity

#### What the model sees

The system-prompt consumer renders the configured `personaPrefix`; Web and Desktop replace it through the later web-defaults layer.

##### Package-owned prompt text

```markdown
You are an AI agent running in VibeDev.
```

#### Token effect

The identity prefix adds a fixed amount of input text; account and provider selection alone add no prompt tokens.

#### KV Cache effect

Changing the rendered persona or selected model can invalidate provider prefix reuse. Credential changes do not enter the prefix.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- These defaults apply only to profiles that include the bundle. Telemetry-disabled defaults do not govern separately installed plugins or user overrides.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
