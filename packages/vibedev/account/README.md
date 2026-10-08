---
description: "Legacy VibeDev account service used by the single-account composition."
kind: "package-reference"
---

# @vibedev/dsh-account

English | [中文](README.zh.md)

## Summary

This package implements the gateway account as `deepseekAccount`. Current VibeDev Next defaults use the separate account in `@vibedev-si/dsh-vibedev`; this provider is retained for the earlier composition.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## Configuration and ownership

The service authorizes through the browser with PKCE, stores its grant in the credentials service, and supplies tokens only for the configured gateway origin.

<a id="model-experience"></a>
## Model Experience

### Account state

#### What the model sees

The account service adds no prompt text. The model provider consumes `resolveToken`; account state and credentials stay outside model input.

#### Token effect

Authorization, profile and balance reads add no model-input tokens.

#### KV Cache effect

Credentials are independent of request-prefix serialization; switching accounts can change available models without rewriting context.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- It occupies `deepseekAccount` and cannot be mounted alongside the official DeepSeek provider on that service. Current dual-account defaults do not mount it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
