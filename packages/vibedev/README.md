---
description: "VibeDev product composition, browser identity and retained gateway providers."
kind: "package-group"
---

# vibedev/ — VibeDev product packages

English | [中文](README.zh.md)

## Summary

The defaults bundles compose VibeDev Next over the Harness runtime. Current dual-account composition gets its VibeDev account, models, media and search from the npm-pinned external plugin; the earlier account and gateway providers remain in this tree and are not mounted by the defaults.

## Table of Contents

- [Packages](#packages)
- [Subsystem ownership](#subsystem-ownership)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Responsibility |
|---|---|
| [defaults](defaults/README.md) | Shared product composition and the external account plugin |
| [web-defaults](web-defaults/README.md) | Web/Desktop composition, secondary DeepSeek account and persona |
| [client-brand](client-brand/README.md) | Browser brand slots |
| [account](account/README.md) | Retained single-account gateway service |
| [llm-gateway](llm-gateway/README.md) | Retained account-route model adapter |
| [web-search-gateway](web-search-gateway/README.md) | Retained gateway search provider |

<a id="subsystem-ownership"></a>
## Subsystem ownership

[Credentials](../../docs/subsystems/credentials.md) owns authorization and token storage; [LLM streaming](../../docs/subsystems/llm-streaming.md) owns adapters and model requests; [Web](../../docs/subsystems/web.md) owns search provider selection; [Web Client](../../docs/subsystems/web-client.md) owns browser composition. Package READMEs describe product-specific behavior and compatibility constraints.

<a id="dev-note"></a>
## Dev Note

None.
