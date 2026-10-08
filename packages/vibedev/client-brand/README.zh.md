---
description: "浏览器侧边栏与会话视图的 VibeDev 品牌。"
kind: "package-reference"
---

# @vibedev/dsh-client-brand

[English](README.md) | 中文

## 概述

本浏览器插件填充侧边栏品牌图标、名称和空会话主图标，Host 入口不提供运行时服务。

## 目录

- [配置与职责](#configuration-and-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## 配置与职责

注册项跟随声明它们的插槽，在插件卸载时撤销。

<a id="model-experience"></a>
## 模型体验

### 浏览器呈现

#### 模型看到什么

`sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark` 只渲染浏览器组件，不向模型提供文字。

#### Token 影响

品牌渲染不增加输入或输出 token。

#### KV Cache 影响

浏览器组件状态独立于模型上下文与前缀复用。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 品牌覆盖范围仅限这些插槽。桌面安装器身份与原生窗口资源由桌面应用负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注</summary>

暂无。

</details>
