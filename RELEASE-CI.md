# VibeDev 桌面端：CI 打包与发布

本文件说明「打 tag → 自动打包 → 草稿 Release → 你点发布」这套流程，以及需要配置的东西。

对应的 workflow：`.github/workflows/vibedev-release.yml`

## 一次性配置

### 1. 仓库设为公开

公开仓库的标准 runner **不花分钟数**，Windows 和 macOS 都免费。私有仓库按分钟计费（Windows ×2、macOS ×10，一次 macOS 打包约合 $48），而且本组织当前账单还是被拒状态。

注意：设成公开**之前**，上游那 23 个 workflow 已经被手动禁用了（它们会在每次推送时跑起来、大量报错）。真要恢复哪一个，去仓库的 Actions 页面单独启用。

### 2. 打开 Actions

`Settings → Actions → General → Allow all actions`（之前按需关闭过）。Workflow permissions 保持默认的 read 即可，本 workflow 自己声明了 `contents: write`。

### 3. 配置 macOS 签名与公证的 secrets

macOS 使用 Developer ID 签名和公证，App ID 固定为 `studio.vibedev.app`；后续 Mac 版本保持这个 ID。Windows 配置独立。

在 `Settings → Secrets and variables → Actions` 配置四项签名 secret，再选择一组完整的公证凭据。两组公证 secrets 不能同时存在，缺项或混用会在打包前失败。

| Secret | 内容 | 怎么拿 |
|---|---|---|
| `MACOS_CSC_P12` | 签名证书 `.p12` 的 base64 | 钥匙串访问里找到 `Developer ID Application: …`，导出为 `.p12`（自己设一个密码），然后 `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CSC_PASSWORD` | 上面 `.p12` 的导出密码 | 导出时设的那个 |
| `MACOS_SIGNING_IDENTITY` | 证书名，**必须去掉 `Developer ID Application:` 前缀**，例如 `VibeDev Technology Limited (AB12CD34EF)` | Mac 上跑 `security find-identity -v -p codesigning` 看 |
| `MACOS_TEAM_ID` | 10 位团队 ID | 同上，括号里那串（10 位大写字母或数字） |

公证方式 A：Apple ID 和 App 专用密码。

| Secret | 内容 | 怎么拿 |
|---|---|---|
| `APPLE_ID` | 有公证权限的 Apple ID | 该签名团队的成员账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码 | 在 Apple 账号管理页面生成；不能用账号登录密码 |
| `APPLE_TEAM_ID` | 公证使用的团队 ID | 与 `MACOS_TEAM_ID` 对应的团队 |

本机的 `vibedev-notary` 钥匙串 profile 不会传到 GitHub runner；CI 需要这三项 secrets。不要把密码写入仓库或发布日志。

写入 `.env.macos` 的 secret 必须是单行值；CI 验证 dotenv 解析后与原值一致，无法保真保存时拒绝打包，避免密码中的 `#` 等字符被截断。

公证方式 B：App Store Connect 团队 API 密钥。

| Secret | 内容 | 怎么拿 |
|---|---|---|
| `APPLE_API_KEY_P8` | App Store Connect API 密钥 `.p8` 的 base64 | App Store Connect →「用户和访问」→「集成」→「团队密钥」→ 生成（权限选 Developer ID / 公证）→ 下载 `.p8`（**只能下一次**）→ `base64 -i AuthKey_XXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | 密钥 ID | `.p8` 文件名里的那串 |
| `APPLE_API_ISSUER` | Issuer ID（UUID） | 团队密钥页面顶部 |

在 Mac 上配置签名和方式 A 的 secrets：

```bash
GH_REPO=VibeDev-Si/vibedev
gh secret set MACOS_CSC_P12        --repo $GH_REPO < cert.p12.base64
gh secret set MACOS_CSC_PASSWORD   --repo $GH_REPO   # 会提示输入
gh secret set MACOS_SIGNING_IDENTITY --repo $GH_REPO
gh secret set MACOS_TEAM_ID        --repo $GH_REPO
gh secret set APPLE_ID --repo $GH_REPO
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo $GH_REPO
gh secret set APPLE_TEAM_ID --repo $GH_REPO
```

选择方式 B 时，用 `APPLE_API_KEY_P8`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 替代上面的三项 Apple ID secrets；不要配置另一组。`MACOS_CSC_P12` 和 `APPLE_API_KEY_P8` 分别接收对应文件的 base64 文本。

`--check` 验证本地配置和工具链，不导入证书，也不验证 Apple 凭据。证书导入、签名与公证由实际打包步骤验证；首次 CI 运行的操作者负责确认这三个步骤成功。

## 日常发版

```bash
git tag -a desktop-v0.2.1-alpha.2.20261013.3 -m "这次改了什么，用户可以在这里看到"
git push origin desktop-v0.2.1-alpha.2.20261013.3
```

之后：

1. 两个平台各自打包（约 30–60 分钟）
2. 安装包自动传进**草稿 Release**
3. 你在 `Releases` 页面核对版本号、文件、更新内容 → 点 **Publish release**
4. 推下载服务器（见下一节）

想重跑：同一页点 Re-run，或手动触发这个 workflow 并填已有的 tag。

## 推下载服务器（目前还是手动）

CI 只负责打包和建 Release。Mac 资产包含安装包、ZIP、blockmap、`nightly-mac.yml` 和记录 commit、版本的 `mac-arm64-release.json`。让用户真正拿到更新，还需要把安装包放到 `https://download.vibedev.studio`：

```bash
corepack pnpm --dir apps/desktop run upload:server:win:x64 -- \
  --ssh root@64.204.25.8 --identity <私钥> --known-hosts <known_hosts> \
  --root /data/vibedev-download/public --via-github VibeDev-Si/vibedev
# macOS 换成 upload:server:mac:arm64
```

⚠️ **已知缺口**：这条命令需要**本地有构建产物**（它读取 `.desktop-build` 里的产物和完成记录），
所以 CI 打出来的包不能直接用它推送。两个补法，需要时我来做：

- 写一个「从 Release 推送」的脚本：读 Release 资产 → 服务器用临时签名链接拉取 → 校验 SHA-512 → 改名生效（复用现有逻辑，约 50 行）；
- 或者把这一步也放进 CI（需要把 SSH 私钥加进 secrets）。

## 还没验证过的地方

- 本机 macOS 正式签名、公证打包已完成，App 和 DMG 的 Apple 公证结果均为 `Accepted`。GitHub 托管 runner 的首次打包仍待验证；首次运行需确认配置校验、证书导入、公证成功，以及产物进入签名版的 `artifacts/` 目录。
- 托管 runner 上 `pnpm install --frozen-lockfile` 会从 raw.githubusercontent.com 拉内置的账号插件包，
  该仓库现在是公开的，正常。
- 未签名的 Windows 包自动更新正常；已签名的 macOS 包自动更新理论上正常（Electron 的 Squirrel.Mac 需要签名，我们有签名）。
