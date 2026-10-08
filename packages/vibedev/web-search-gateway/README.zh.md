---
description: "旧版网关网络搜索提供方。"
kind: "package-reference"
---

# @vibedev/dsh-web-search-gateway

[English](README.md) | 中文

## 概述

本包向 web 服务注册 `vibedev-gateway`，经 `deepseekAccount` 或配置的开发 key 认证。当前默认配置从外部 VibeDev 账号插件获得此提供方。

## 目录

- [配置与职责](#configuration-and-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## 配置与职责

搜索使用 `/v1/vibedev/web-search`，提供方限制结果数量、串行排队，并在配置范围内重试被拒绝的凭据或暂时性失败。

<a id="model-experience"></a>
## 模型体验

### 搜索结果

#### 模型看到什么

web 消费者把网关的 `results` 和 `answers` 呈现为搜索来源和摘要，内容取决于查询与网关响应。

#### Token 影响

保留的搜索文字为后续模型请求增加可变输入 token；本提供方不添加系统提示词或工具 schema。

#### KV Cache 影响

追加搜索结果保留先前请求前缀，后续复用取决于消费者序列化与提供方缓存。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- web 服务只使用一个配置的搜索提供方；与账号插件同时加载本包会重复注册 `vibedev-gateway` 并被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注</summary>

暂无。

</details>
