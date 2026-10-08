---
description: "VibeDev 产品组合、浏览器身份与保留的网关提供方。"
kind: "package-group"
---

# vibedev/ — VibeDev 产品包

[English](README.md) | 中文

## 概述

默认 bundle 在 Harness 运行时之上组合 VibeDev Next。当前双账号组合从 npm 精确版本的外部插件获得 VibeDev 账号、模型、媒体与搜索能力；此前的账号与网关提供方保留在本目录中，默认配置不加载它们。

## 目录

- [包](#packages)
- [子系统归属](#subsystem-ownership)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [defaults](defaults/README.zh.md) | 共享产品组合与外部账号插件 |
| [web-defaults](web-defaults/README.zh.md) | Web/Desktop 组合、DeepSeek 副账号与身份提示词 |
| [client-brand](client-brand/README.zh.md) | 浏览器品牌插槽 |
| [account](account/README.zh.md) | 保留的单账号网关服务 |
| [llm-gateway](llm-gateway/README.zh.md) | 保留的账号路由模型适配器 |
| [web-search-gateway](web-search-gateway/README.zh.md) | 保留的网关搜索提供方 |

<a id="subsystem-ownership"></a>
## 子系统归属

[凭据](../../docs/subsystems/credentials.zh.md)负责授权与令牌保存；[LLM 流](../../docs/subsystems/llm-streaming.zh.md)负责适配器与模型请求；[Web](../../docs/subsystems/web.zh.md)负责搜索提供方选择；[Web 客户端](../../docs/subsystems/web-client.zh.md)负责浏览器组合。各包 README 说明产品特有行为及兼容限制。

<a id="dev-note"></a>
## 开发备注

暂无。
