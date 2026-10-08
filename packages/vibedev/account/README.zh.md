---
description: "单账号组合使用的旧版 VibeDev 账号服务。"
kind: "package-reference"
---

# @vibedev/dsh-account

[English](README.md) | 中文

## 概述

本包把网关账号注册为 `deepseekAccount`。当前 VibeDev Next 默认使用 `@vibedev-si/dsh-vibedev` 的独立账号；本实现保留给此前的单账号组合。

## 目录

- [配置与职责](#configuration-and-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## 配置与职责

服务经系统浏览器执行 PKCE 授权，在凭据服务中保存授权记录，并且只向配置的网关来源提供令牌。

<a id="model-experience"></a>
## 模型体验

### 账号状态

#### 模型看到什么

账号服务不添加提示词。模型提供方调用 `resolveToken`，账号状态和凭据不进入模型输入。

#### Token 影响

授权、身份与余额读取不增加模型输入 token。

#### KV Cache 影响

凭据与请求前缀序列化无关；切换账号可以改变可用模型，但不改写上下文。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 本包占用 `deepseekAccount`，不能与官方 DeepSeek 提供方同时注册此服务。当前双账号默认配置不加载它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注</summary>

暂无。

</details>
