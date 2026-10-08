---
description: "使用账号路由的旧版网关模型适配器。"
kind: "package-reference"
---

# @vibedev/dsh-llm-gateway

[English](README.md) | 中文

## 概述

本提供方在 `deepseek-account` 路由注册网关模型，经 `deepseekAccount` 获取凭据，并支持配置的开发 key 回退。当前双账号默认配置使用外部 VibeDev 插件。

## 目录

- [配置与职责](#configuration-and-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## 配置与职责

配置控制网关来源、显示名称、目录刷新与超时、优先模型和提示词缓存保留策略。

<a id="model-experience"></a>
## 模型体验

### 网关模型请求

#### 模型看到什么

适配器把已有会话与工具 schema 发送到选定网关模型。认证和 `/v1/models` 目录读取不添加本包拥有的提示词。

#### Token 影响

实际用量取决于模型和序列化请求；目录与凭据读取不增加输入 token。

#### KV Cache 影响

`cacheRetention` 请求提供方支持的缓存保留；消息序列化和前缀复用由传输层负责。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 同时注册时，`deepseek-account` 路由与官方账号适配器冲突。当前默认配置不加载此旧版提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注</summary>

暂无。

</details>
