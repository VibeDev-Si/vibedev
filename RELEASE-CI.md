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

macOS 是**正常签名 + 公证**的（Windows 才是未签名）。下面 7 个 secret 加在
`Settings → Secrets and variables → Actions`。

| Secret | 内容 | 怎么拿 |
|---|---|---|
| `MACOS_CSC_P12` | 签名证书 `.p12` 的 base64 | 钥匙串访问里找到 `Developer ID Application: …`，导出为 `.p12`（自己设一个密码），然后 `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CSC_PASSWORD` | 上面 `.p12` 的导出密码 | 导出时设的那个 |
| `MACOS_SIGNING_IDENTITY` | 证书名，**必须去掉 `Developer ID Application:` 前缀**，例如 `VibeDev Technology Limited (AB12CD34EF)` | Mac 上跑 `security find-identity -v -p codesigning` 看 |
| `MACOS_TEAM_ID` | 10 位团队 ID | 同上，括号里那串（10 位大写字母或数字） |
| `APPLE_API_KEY_P8` | App Store Connect API 密钥 `.p8` 的 base64 | App Store Connect →「用户和访问」→「集成」→「团队密钥」→ 生成（权限选 Developer ID / 公证）→ 下载 `.p8`（**只能下一次**）→ `base64 -i AuthKey_XXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | 密钥 ID | `.p8` 文件名里的那串 |
| `APPLE_API_ISSUER` | Issuer ID（UUID） | 团队密钥页面顶部 |

在 Mac 上用命令行加（更省事）：

```bash
GH_REPO=VibeDev-Si/vibedev
gh secret set MACOS_CSC_P12        --repo $GH_REPO < cert.p12.base64
gh secret set MACOS_CSC_PASSWORD   --repo $GH_REPO   # 会提示输入
gh secret set MACOS_SIGNING_IDENTITY --repo $GH_REPO
gh secret set MACOS_TEAM_ID        --repo $GH_REPO
gh secret set APPLE_API_KEY_P8     --repo $GH_REPO < AuthKey.p8.base64
gh secret set APPLE_API_KEY_ID     --repo $GH_REPO
gh secret set APPLE_API_ISSUER     --repo $GH_REPO
```

（公证也可以用 Apple ID 那套替代：`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。
API 密钥更稳，推荐。）

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

## 推下载服务器

CI 只负责打包和建 Release。你在页面上点了 **Publish release** 之后，用 `publish-release.ts`
把 Release 里的资产推到下载服务器——它读的是 Release，**不需要本地有构建产物**：

```bash
# 先看一眼要做什么（只读 GitHub，不碰服务器）
corepack pnpm --dir apps/desktop run upload:release:win:x64 \
  --tag desktop-v0.2.1-alpha.2.20261013.4 \
  --ssh root@64.204.25.8 --identity <私钥> --known-hosts <known_hosts> \
  --root /data/vibedev-download/public --latest --dry-run

# 确认无误后去掉 --dry-run 真跑
```

macOS 把 `upload:release:win:x64` 换成 `upload:release:mac:arm64`（Intel 是 `mac:x64`）。

它做的事：

- 服务器用 GitHub 给的一次性签名链接拉取每个文件（服务器仍然不需要 GitHub 凭据），中途存成临时名；
- **校验**：更新载荷对比清单里承诺的 SHA-512，其余文件对比 GitHub 记录的 SHA-256（两处都是服务器本机算的）；
- 通过后改名到位；**更新清单最后发布**，保证清单不会先指向还不存在的文件；
- 已发布的带版本文件不可修改：字节相同＝跳过，字节不同＝报错停下；清单是唯一允许变的；
- `--latest` 把同一个安装包复制到固定下载地址（服务器端 cp，不重新传）；
- 最后在服务器本机用 nginx 回读每个地址，确认真的能下。

> 为什么清单必须改写：electron-builder 写的是**相对**载荷名，而应用会把它解析到清单所在目录
> （`feeds/win-x64/`）。二进制实际在 `bin/win-x64/`，不改写就会 404。脚本发布前把它改成绝对地址。

### 这个脚本验证到什么程度

- 13 个单元测试：标签解析、两个平台的清单改写与路径规划、缺文件/清单不匹配的报错、
  固定下载名、服务器返回相同/不同字节时的行为。
- 对真实 Release（`desktop-v0.2.1-alpha.2.20261013.2`）跑过一次完整流程：服务器上三个文件
  全部识别为「未变」（字节确实一致），`--latest` 复制成功，nginx 回读 4 个地址都是 200。
- **未验证**：从零开始的一次真实上传（即服务器上还没有这些文件时的下载+校验+改名路径）。
  这条路径要等第一个 CI 版本发布时才会走到；那之前先用 `--dry-run` 核对计划。

## 还没验证过的地方

- **macOS 打包这条路本仓库还没跑过一次**。第一次跑要重点看：`--check` 是否通过、证书能否进钥匙串、
  公证是否成功、产物目录是不是 `artifacts/`（签名版）而不是 `unsigned-artifacts/`。
- 托管 runner 上 `pnpm install --frozen-lockfile` 会从 raw.githubusercontent.com 拉内置的账号插件包，
  该仓库现在是公开的，正常。
- 未签名的 Windows 包自动更新正常；已签名的 macOS 包自动更新理论上正常（Electron 的 Squirrel.Mac 需要签名，我们有签名）。
