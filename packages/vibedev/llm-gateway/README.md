---
description: "Legacy gateway model adapter on the account route."
kind: "package-reference"
---

# @vibedev/dsh-llm-gateway

English | [中文](README.zh.md)

## Summary

This provider registers gateway models on `deepseek-account` and authenticates through `deepseekAccount`, with the configured development-key fallback. Current dual-account defaults use the external VibeDev plugin instead.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## Configuration and ownership

Configuration controls gateway origin, displayed provider name, catalog refresh and timeout, preferred models and prompt-cache retention.

<a id="model-experience"></a>
## Model Experience

### Gateway model requests

#### What the model sees

The adapter sends the existing conversation and tool schemas to the selected gateway model. Authentication and `/v1/models` discovery add no package-owned prompt.

#### Token effect

Actual usage follows the selected model and serialized request; catalog and credential reads add no input tokens.

#### KV Cache effect

`cacheRetention` requests provider-supported retention. The transport owns message serialization and prefix reuse.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- The `deepseek-account` route conflicts with the official account adapter when both are registered. This legacy provider is not mounted by current defaults.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
