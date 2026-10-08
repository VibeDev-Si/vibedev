---
description: "Legacy gateway web-search provider."
kind: "package-reference"
---

# @vibedev/dsh-web-search-gateway

English | [中文](README.zh.md)

## Summary

This package registers `vibedev-gateway` with the web service and authenticates through `deepseekAccount` or the configured development key. Current defaults obtain this provider from the external VibeDev account plugin.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## Configuration and ownership

Searches use `/v1/vibedev/web-search`. The provider bounds query result counts, queues requests and retries rejected credentials or transient failures within its configured limits.

<a id="model-experience"></a>
## Model Experience

### Search results

#### What the model sees

The web consumer exposes gateway `results` and `answers` as search sources and summary text. Their contents depend on the query and gateway response.

#### Token effect

Retained search text adds variable input tokens to later model requests; the provider adds no system prompt or tool schema.

#### KV Cache effect

Appending a search result preserves the prior request prefix; subsequent reuse depends on consumer serialization and provider caching.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- The web service selects one configured search provider. Mounting this package alongside the account plugin would duplicate `vibedev-gateway` and is rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
