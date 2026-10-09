---
kind: upgrade-guide
description: "VibeDev 默认使用美国 API，需重新登录，不再恢复历史未隔离的网关状态。"
---

# VibeDev 网关与账号状态

[English](guide.md) | 中文

## 变更

VibeDev 默认使用 `https://api.vibedev.studio`。账号插件为每个规范化网关 origin 使用独立凭据键和状态目录。历史未标注的登录文件、凭据记录和媒体任务保留在磁盘上，但不导入或恢复；旧视频、音频和上传任务不重新提交。DeepSeek 账号、本地聊天、工作区和历史媒体 URL 不变。可选的 `us-candidate.patch.yml` 导出已移除。

VibeDev Next 的欢迎页仅由 VibeDev 主账号控制。退出 DeepSeek 或其会话过期时保持工作区打开；退出 VibeDev 时回到欢迎页，即使 DeepSeek 仍已登录或其它模型提供商的密钥仍已配置。在官方 DSH 中将插件作为副账号安装时，仍保留官方 DeepSeek 的进入应用逻辑。

即使 profile 中还保留旧的独立安装副本，桌面 Host 也使用安装包内置的 VibeDev 组件。重复的独立 bundle 不再覆盖应用的主账号配置。这是运行时选择规则，不删除或改写已安装文件、manifest、锁文件、登录记录及其它插件。用户明确配置和禁用的选择仍生效。

## 迁移

1. 检查 `$DSH_HOME/cordis.patch.yml` 和 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 中的 `dsh-vibedev` 行。移除过时的 `gatewayOrigin` 覆盖以继承默认值，或明确设为 `https://api.vibedev.studio`，保留其它设置。账号路线使用 `apiKeyEnv: ''`，移除对已停用候选 overlay 的引用。
2. 重启应用，从侧边栏或「设置 → VibeDev 账号」登录。鉴权保留 PKCE S256、state 和随机 localhost 回调，不要将回调换成存储域名。模型列表仅在登录后出现。
3. 保留历史状态，不要把旧任务 ID 或未标注的登录记录复制到新 origin 命名空间。签名上传下载 URL 按 API 返回原样使用，不改写旧媒体链接。
4. 确认登录链接以及鉴权模型目录、搜索请求使用美国 API。服务器503仍表示拒绝，不能触发另一网关或新的媒体生成。
5. 登录网页还需要网关的公开 `api_base_url` 和充值链接设置为美国 API。修改桌面默认值无法改变网关网页返回的配置。
