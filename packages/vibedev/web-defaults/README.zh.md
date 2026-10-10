---
description: "Web 和 Desktop 的 VibeDev 产品组合。"
kind: "package-bundle"
---

# @vibedev/dsh-web-defaults

[English](README.md) | 中文

## 概述

本 bundle 在 `dsh-web-app` 之后加载，停用 DeepSeek 产品分析和品牌，加载 VibeDev 浏览器品牌，内置 VibeDev 生态，把 DeepSeek 账号放在侧边栏副账号入口，并配置 Web 服务。

## 目录

- [配置与职责](#configuration-and-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration-and-ownership"></a>
## 配置与职责

完整行配置以 [cordis.patch.yml](cordis.patch.yml) 为准，其中包含 Web 身份与当前 profile 的插件安装指引。

VibeDev 生态（`@vibedev-si/dsh-ecosystem`，在此处与 CLI 安装锚点精确固定同一版本）以它自己的行 id `vibedev-center` 插入，并带 `config: { official: true }`：插件页把它列在「官方」分组，点开卡片即进入生态页面，生态显示版本随应用更新。Desktop Host 把它列为安装内插件，profile 里此前安装的副本不会同时加载。

本包模块本身就是 `vibedev-web-runtime` 行：dsh-v0.2.1-alpha.2 用 `webStartup` 取代了 `webRuntime` 服务，而为早期版本编写的插件（媒体预览、Better Sidebar）依赖 `webRuntime`。该行按 alpha.1 的方式提供它，取值来自监听地址与 `--trusted-host`。

<a id="model-experience"></a>
## 模型体验

### Web 身份与插件指引

#### 模型看到什么

系统提示词消费者把选定模型渲染到 `personaPrefix`；`personaSuffix` 是本包拥有的插件指引。自 `dsh-v0.2.1-alpha.2` 起工作目录不再是提示词变量，由 `working_directory` 工具告知。

##### 所属提示词文字

```markdown
You are a coding agent running in VibeDev, powered by the {{model}} model.

Plugins in VibeDev are installed, enabled, and removed on the Plugins page (Plugins → Add plugin), which installs into the profile this app runs. When the user asks to install a plugin, send them there with the package name. The command-line equivalent, when `vibedev-app` is on PATH, is `vibedev-app plugin --profile desktop add <package>` for the desktop app, which must be fully quit first. Plugin READMEs written for DeepSeek Harness say `dsh plugin --profile web add <package>`: never run that for VibeDev. A `dsh` command on PATH belongs to the separate DeepSeek Harness app, and a `web` profile is not the one the VibeDev desktop app loads.
```

#### Token 影响

身份与安装指引增加固定文本；模型名的渲染值决定其余输入 token。

#### KV Cache 影响

身份、模型或目录变化可能使请求前缀无法复用；浏览器品牌和账号菜单布局不进入模型输入。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 此层依赖 Web 组合，不配置无界面 profile 或原生桌面安装器品牌。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注</summary>

暂无。

</details>
