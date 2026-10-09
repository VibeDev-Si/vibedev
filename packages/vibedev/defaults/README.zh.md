---
description: "发布配置共同使用的 VibeDev 产品组合。"
kind: "package-bundle"
---

# @vibedev/dsh-defaults

[English](README.md) | 中文

## 概述

本 bundle 在 `dsh-base` 上叠加 VibeDev 身份、停用 DeepSeek 遥测、VibeDev 账号插件以及网关模型和搜索默认项。官方 DeepSeek 账号保留为副账号。

## 目录

- [配置与职责](#configuration-and-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## 配置与职责

行配置以 [cordis.patch.yml](cordis.patch.yml) 为准，可被 profile 和 home 层覆盖；账号插件使用 npm 精确版本依赖。

正式配置使用 `https://api.vibedev.studio`，禁用开发密钥回退（`apiKeyEnv: ''`），用户登录后再选模型。媒体链接始终使用服务器返回的完整签名 URL，预期存储域为 `https://media.vibedev.studio`。每个 origin 都有独立凭据和媒体状态；历史未标注的登录和任务记录保留但不恢复，升级后需重新登录。候选 overlay 不再随包提供。本地验证不解除服务器503挡板，不发出真实模型或付费媒体请求；见[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.1/vibedev-gateway/guide.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 产品身份

#### 模型看到什么

系统提示词消费者渲染配置的 `personaPrefix`；Web 和 Desktop 通过后续的 web-defaults 层替换它。

##### 所属提示词文字

```markdown
You are an AI agent running in VibeDev.
```

#### Token 影响

身份前缀增加固定的输入文本；账号和提供方选择本身不添加提示词 token。

#### KV Cache 影响

渲染身份或模型变化可能使提供方无法复用已有前缀；凭据变化不进入前缀。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 默认项仅作用于包含本 bundle 的 profile。停用遥测的默认配置不约束另行安装的插件或用户覆盖项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注</summary>

暂无。

</details>
