# VibeDev 桌面端：CI 打包与发布

本文件说明「打 tag → 自动打包 → 草稿 Release → 你点发布」这套流程，以及需要配置的东西。

对应的 workflow：`.github/workflows/vibedev-release.yml`

一次打 tag 会跑三个打包 job（互不影响，任一失败不阻塞另外两个）：

| job | 机器 | 产物 |
|---|---|---|
| `windows` | `windows-latest` | 未签名的 x64 安装包 + 更新清单 |
| `macos` | `macos-14`（Apple 芯片） | 签名 + 公证的 arm64 DMG/ZIP |
| `macos-x64` | `macos-15-intel`（原生 Intel） | 签名 + 公证的 x64 DMG/ZIP |

> ⚠️ **更新清单在 Release 里的名字带目标名**：两个 mac 架构的清单都叫 `nightly-mac.yml`，
> 同名上传会互相覆盖，发布脚本也就分不清拿到的是哪个架构。所以三个 job 分别上传
> `win-x64-nightly.yml`、`mac-arm64-nightly-mac.yml`、`mac-x64-nightly-mac.yml`。
> 服务器上的目录不变（仍是 `dsh-desk/feeds/<target>/`）。`publish-release.ts` 优先找带目标名的，
> 找不到才退回原名——20261013.4 之前发布的 Release 里只有原名，仍然可用。

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

⚠️ tag 说明里**不要用 `#` 开头的行**：`git tag` 默认的 cleanup 会把它当注释删掉（20261013.4 那次实测丢过两个 `##` 小标题），
要分段就用 **加粗**；一定要用 `#` 标题就加 `--cleanup=verbatim`。丢了之后工作流拿到的说明里本来就没有那些行，无法补救。
写长说明用 `-F 文件` 更稳（避免命令行引号问题），但同样受这条限制。

之后：

1. 两个平台各自打包（约 30–60 分钟）
2. 安装包自动传进**草稿 Release**
3. 你在 `Releases` 页面核对版本号、文件、更新内容 → 点 **Publish release**
4. 推下载服务器（见下一节）

想重跑：同一页点 Re-run，或手动触发这个 workflow 并填已有的 tag。

## 推下载服务器

CI 只负责打包和建 Release。你在页面上点了 **Publish release** 之后，用 `publish-release.ts`
把 Release 里的资产推到下载服务器——它读的是 Release，**不需要本地有构建产物**：

Mac 资产包含安装包、ZIP、blockmap、`nightly-mac.yml` 和记录 commit 与版本的 `mac-arm64-release.json`。

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

- 16 个单元测试：标签解析、两个平台的清单改写与路径规划、缺文件/清单不匹配的报错、
  固定下载名、按目标挑清单、服务器返回相同/不同字节时的行为。
- 对真实 Release（`desktop-v0.2.1-alpha.2.20261013.2`）跑过一次幂等流程：服务器上三个文件
  全部识别为「未变」（字节确实一致），`--latest` 复制成功，nginx 回读 4 个地址都是 200。
- **从零上传这条路已于 2026-10-13 实测通过**（见下一节的表格）。

## 已实测通过（2026-10-13，发布 `0.2.1-alpha.2.20261013.4`）

第一次完整的 CI 发布，从 tag 到下载服务器：

| 环节 | 结果 |
|---|---|
| `prepare` / `windows` / `macos` 三个 job | 全绿；Windows ≈14 分钟、macOS ≈19 分钟（日志里 `DMG creation and notarization completed in 237.82s`） |
| 托管 runner 上的签名 + 公证 + 装订 | 通过（打包流程内的 `verifyMacOSSignatureAfterSign` / `verifyMacOSNotarizedApplication` / `verifyMacOSDiskImage` 都执行了，job 绿即通过） |
| 草稿 Release（人工闸门） | 8 个资产齐全；草稿状态下 `publish-release.ts` 按 tag 读不到（404）→ **天然拒绝提前推送** |
| 从 Release 推下载服务器（第一次走这条路） | macOS 5 个 key、Windows 4 个 key 全部上传 + nginx 回读 200；服务器本机算出的 SHA-256 与 GitHub 记录的 digest 一致 |
| 公网复核 | 三个固定下载名与两个 feed 都可用；feed 里的载荷是**绝对地址**且指向正确的二进制 |

### ⚠️ app id 就是 Windows 的升级身份（花了一整轮沙盒验证换来的）

`multiUser.nsh:8` 把 `INSTALL_REGISTRY_KEY` 定义成 `Software\<APP_GUID>`，而 electron-builder 默认让 GUID 等于 appId；
`installSection.nsh:52` 的 `uninstallOldVersion` **只清理自己 GUID 下的旧记录**。所以：

- **改了 appId，就换了升级身份。** 新安装器装到旧装目录上会被目录守卫拦下，直接弹窗
  「请选择空文件夹，或 VibeDev 原来的安装目录」——**不会就地升级**。
- 实测：`20261013.1/.2`（旧 id `cn.bigopen.vibedev.app`）→ `20261013.4`（新 id `studio.vibedev.app`）必须先**卸载再安装**；
  卸载不会删用户数据（`uninstaller.nsh:217` 默认 `$isDeleteAppData="0"`，我们也没定义 `DELETE_APP_DATA_ON_UNINSTALL`）。
- 对自动更新的影响：旧装会反复下载却永远装不上（静默模式下安装器 1 秒返回、零改动）。**所以换 id 的那一版不要急着推 feed**，
  等旧装都手动清理干净再推。
- 结论：**appId 从此视为不可再改**。真要改，就得接受一次全员手动卸载重装。

## 还没验证过的地方

- 未签名的 Windows 包自动更新正常；已签名的 macOS 包自动更新**待实测**（Squirrel.Mac 会校验签名，我们的包有签名）。
- **macOS Intel(x64) 这条路一次都没跑过**：`package:mac:x64` 命令、上传/发布脚本都支持（固定下载名是
  `dsh-latest-macos-x64.dmg`），但 fork 里从未真正构建过。第一次跑要看：`--check` 是否通过、原生模块能否在
  Intel 机器上装好、公证是否成功。这个 job 是独立的，它失败不影响 arm64 和 Windows 出包。
- 苹果的 Intel 机器已经进入退场期（macOS 26 之后不再支持），但存量机器还有，所以这一版先出着。
