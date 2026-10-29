# Fork 规范：OpenBitFun 安卓控制器

本文是**本 fork 自有规范**，不是上游文档。上游约定见根 `AGENTS.md` 与 `src/apps/mobile/AGENTS.md`。
建立于 2026-10-29，起于上游 tag `v1.0.7`（commit `db7d365`），已同步至 `v1.0.8`（commit `f883190`）。

## 0. 现状快照（2026-10-29）

| 项 | 状态 |
|---|---|
| 分支 / HEAD | `fork/mobile`，基线 = 上游 `v1.0.8`（commit `f883190`） |
| 上游历史 | 已 `--unshallow`，5832 commits，`v1.0.7` 是 `v1.0.8` 的祖先 |
| 私有差异 | 全部带 `fork:` 前缀，用 `git log --grep='^fork' v1.0.8..HEAD` 列出 |
| 工作树 | 干净 |
| 可装机产物 | `OpenBitFun-Fork-1.0.8-fork.1-android.apk`（4.94 MB，v2 签名） |
| 协议号 | 三端仍为 `2`，与你桌面 1.0.7 兼容 |
| **未闭环** | 真机握手验收（无设备、BIOS 未开 VT-x）、GitHub fork 远端（需你点） |

## 1. 这个 fork 是什么

只改造安卓端表现层的**个人长期使用版**，连接链路原样复用官方：

- **品牌不改**：`applicationId` 仍为 `com.openbitfun.mobile`，`app_name` 仍为 `OpenBitFun`，图标、`Theme.OpenBitFun`、深链 scheme 全部沿用。
- **走官方 Relay + 同一 GitHub 账户**：协议、加密、服务端零改动。
- **协议号必须保持 2**。三处由 `ClientBuildContractTest` 钉死（Rust `account.rs:25`、TS `ClientBuild.ts`、KMP `ClientBuild.kt`）。你的桌面端与 APK 都上报 `2`，`CLIENT_VERSION` 字符串不参与 gate。
- **深链 `openbitfun://auth/callback` 不要改**。它只是唤醒信号，token 实际来自 relay 轮询（`AccountStore.kt:752-759`），且唤醒外包了 `withTimeoutOrNull`（L694）——收不到只是慢一个间隔。但上游托管的 `auth.openbitfun.com` 用精确白名单校验（`src/miniapp-market-web/src/authReturnTo.ts:13`），改成自定 scheme 会被丢弃，等于放弃官方账户路径。

### 为什么不用官方 APK 长期使用

官方移动端只有 **1 个** release：`mobile-v1.0.0`（2026-10-10，`prerelease`，标题自带 "debug signing"，4.69 MB），无应用商店上架，iOS/鸿蒙只有源码。它的签名来自 `mobile-package.yml:78` —— **每次 CI 用当场新生成的 runner debug keystore**。结论：官方包之间**无法互相覆盖安装**（换签名必卸载），也不与任何正式签名兼容。这不是缺陷，是上游明确写的"生产 key 以后再引入"（`:99`）。所以自建 + 自有稳定 keystore 是唯一能长期升级的路。

## 2. 提交规范

沿用上游的 **Conventional Commits**（`CONTRIBUTING.md:138`）。fork 的额外约定：

| 前缀 | 用途 |
|---|---|
| `fix(mobile):` / `feat(mobile):` | 与上游同义，保持可直接提 PR 回上游 |
| `fork:` | **只属于本 fork**、不打算回上游的改动（keystore 配置、版本注入、本地规范） |
| `fork(sync):` | 跟随上游的合并/变基记录 |

判断标准很简单：**会往上游提 PR 的改动不许带 `fork:` 前缀**。这样 `git log --grep='^fork'` 就能一键列出全部私有差异，是每次同步的冲突预告清单。

**上游 `main` 是唯一协作分支**（`CONTRIBUTING.md:164`），我们不动它的默认分支假设。

## 3. 分支与远端

```
upstream = git@github.com:GCWing/OpenBitFun.git   # 只读，跟进用
origin   = git@github.com:<你的账户>/OpenBitFun.git  # 可推，备份用
```

- `fork/mobile` — 日常开发区。
- `fork-v<versionName>` — 每个装机的 APK 打一条，固定"哪个 commit 出了哪个 APK"。已打 `fork-v1.0.8-fork.1`。

> ⚠️ 现状（2026-10-29）：本仓库只有 `origin` 指向 GCWing，因为 fork 还没建——`gh` 未安装、`api.github.com` 无 token，**这步只能你在网页上点 Fork**。你的 SSH key 认证为账户 **`Andykpa`**。建好后执行：
> ```
> git remote rename origin upstream
> git remote add origin git@github.com:Andykpa/OpenBitFun.git
> git push -u origin fork/mobile --follow-tags
> ```
> 在此之前 `sync-upstream.ps1` 把 `origin` 当上游用（脚本会自动优先取 `upstream`，改名后无需改脚本）。
> **不要用 HTTPS 推**：`github.com:443` 在本机被墙，只有 `22` 端口通，且 22 端口**间歇性 connection reset**（实测同一命令第一次通、第二次断），所以同步脚本对 fetch 做了三次重试 + 本地已有 tag 则完全跳过网络。见 `portable-toolchain` 技能。

## 4. 版本标识（可升级性的核心）

Android 要求 `versionCode` 严格递增才能覆盖安装。**上游把 `versionCode` 永久钉在 `1`**（历史上只动 `versionName`，见 `981d5b9b3`），所以上游自己从来不支持移动端升级。本 fork 不复制这个缺陷。

```
versionCode = major*1_000_000 + minor*10_000 + patch*100 + build
versionName = <upstream>-fork.<build>
```

`build` 取 `1..99`，每个上游版本从 1 重新计数即可保证单调：
`1.0.7-fork.99` = 1000799 < `1.0.8-fork.1` = 1000801 ✓

实现方式：`src/apps/mobile/android/app/build.gradle.kts` 里**保留上游的 `versionCode = 1` / `versionName = "1.0.0"` 字面量不动**，另起一个 `defaultConfig {}` 块从环境变量 `FORK_VERSION_CODE` / `FORK_VERSION_NAME` 覆盖。原因：上游 `scripts/verify-release-version-sync.mjs:23` 用正则读**第一个匹配**的 `versionName`，改字面量会让它的校验脚本和以后每次 rebase 一起坏掉。这是本 fork 唯一一处碰上游构建脚本的改动，标记为 `// Fork delta`。

## 5. 签名纪律（不可逆，先读这段）

keystore 在**仓库外**：

```
D:\software\qwnpawagent\android-signing\fork-release.keystore
D:\software\qwnpawagent\android-signing\fork-release.password
```

- 证书 DN `CN=OpenBitFun Fork`，指纹 `d3fbee72…86e7b1`，RSA 3072，PKCS12，有效期 10950 天，别名 `forkrelease`。
- **换 keystore = 老 APK 全部要卸载重装**，配对与登录态一起丢。定了就别换。
- 密码与 keystore **绝不入库**（`src/apps/mobile/AGENTS.md` 的 "Keep credentials, signing files … out of the repository" 同样要求）。
- `app/build.gradle.kts` 的默认分支会在缺 4 个环境变量时**静默回落到本机 debug keystore**——所以每次发布必须验签，`.fork/build-release.ps1` 已经把验签失败做成硬错误（DN 不含 `OpenBitFun Fork` 就拒绝记账）。

## 6. 发布流程

```powershell
Set-Location D:\dy\obf_moblie\OpenBitFun
.\.fork\build-release.ps1 -Build 1        # -Build 递增，绝不重用
```

脚本按顺序做，任一失败即止：

1. 读 `package.json` 算出版本，**构建前**检查 `versionCode` 是否大于账本最大值（重用 index 秒级失败，不浪费一次 Gradle）
2. 检查工作树干净——保证"一个 APK 对应一个确定的 commit"（临时构建可 `-AllowDirty`）
3. 从 4 个环境变量注入签名与版本
4. 补齐 gitignored 的 design-system 产物（junction + `node scripts/build.mjs`，**不需要 `pnpm install`**，做法见 `portable-toolchain` 技能）
5. 跑 `mobile:ui` 漂移门禁
6. `:app:assembleRelease`（R8 + 资源压缩，约 4.7 MB）
7. `apksigner --print-certs` 验签名者 + `aapt2 dump badging` 验 `versionCode` 真的进了产物
8. 追加账本 `D:\software\qwnpawagent\android-apk\releases.csv`（**故意放在仓库外**：仓库内的追加型账本会让每次构建弄脏工作树、阻塞 rebase）

产物落 `D:\software\qwnpawagent\android-apk\OpenBitFun-Fork-<versionName>-android.apk`。

已出两版，均实测通过（验签 + `aapt2` 复核 versionCode 真进了产物）：

| versionName | code | sha256 | head |
|---|---|---|---|
| `1.0.7-fork.1` | 1000701 | `22FDD3007C356A7408C1161511B7FDE32F297652ABECF3B755574D79909EE7B5` | `db7d365` |
| `1.0.8-fork.1` | 1000801 | `A9A0CDC9874347928FC1F967999C7E447220B2CAED5E6A855FD4B6D8D87C2C1E` | `5e83e97` |

装机：`tools\android\platform-tools\adb.exe install -r <apk>`（`-r` 保留数据；报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 说明装过官方包或别的签名，必须先卸载）。

## 7. 跟进上游

```powershell
.\.fork\sync-upstream.ps1 -To v1.0.8      # 先 dry-run 看 diff，再 -Rebase
```

纪律：**能 rebase 就别 merge**，保持线性历史，私有差异只剩一串 `fork:` commit。
Relay 会逐步加 capability 协商（`host_stream_v1`、`device_alias_v1` 等），缺 capability 就降级。
**不要改成"猜着发未知命令"**——那是这个 fork 能长期跟住上游的前提。

> 同步的前提是**完整历史**。clone 时用了 `--depth 1` 会让 `merge-base` 算不出来、rebase 无从谈起；本仓库已 `git fetch --unshallow`（5832 commits）。若以后重新 clone，务必取全量历史，或至少 `--deepen=40` 到最近两个 tag 有共同祖先。
>
> `v1.0.7 → v1.0.8` 的实测：上游对 `src/apps/mobile` **零改动**，rebase 无冲突，门禁 4 条违规在同步前后完全一致（新增 0）。脚本对已同步的 tag 重复执行是幂等的。

## 8. 已知上游缺陷（别追，别修，别拿来当自己的责任）

在**未改一行的 v1.0.7 干净树**上实测，以下三项本来就红：

| 门禁 | 现象 | 定性 |
|---|---|---|
| `mobile:architecture` → `sharedReachesPlatformTrees` | `ClientBuildContractTest.kt:60` 读 `harmonyos/**/ClientBuild.ets` | 检查脚本 `scripts/check-mobile-architecture.mjs` 的规则 6 **不排除测试源码集**，且 L419-431 的 `expected` 全硬编码 `[]`、**没有 baseline 机制**。是门禁 bug |
| `mobile:architecture` → `defaultArgsInFeatureApi` | `AccountUiState.kt:21`、`RemoteSidebarPresentation.kt:36`、`ConversationModels.kt:40` | 规则理由是 Kotlin 默认参数传不到 Swift；已核实 `main` 上仍在，上游自己没跑过这条 |
| `shared/ jvmTest` | `RemoteSessionStoreTest.kt:1757` `expected:<[photo-1]> but was:<null>` | 757 例仅此 1 败，3 次复现稳定、非 flaky；**v1.0.8 仍是 757/1 同一个用例**，上游未修 |

`mobile:architecture` **不被任何 GitHub workflow 引用**（`ci.yml` / `desktop-package.yml` / `mobile-package.yml` 全无，根 `AGENTS.md` 也没有）——纯 contributor 手动脚本，所以上游带着它发版不奇怪。

另：在 Windows 主机跑 `shared/ gradlew` 会打印 `Cross Compilation with Cinterop Not Supported in project 'core-crypto'`（iOS 目标的 `openBitFunArgon2` cinterop 无法在 `mingw_x64` 处理）。这是 **warning 不是 error**——本 fork 只构建安卓，忽略即可。

fork 的约定：**不为了让门禁变绿去改上游 `shared/`，也不削弱检查脚本**。`sync-upstream.ps1` 会先取上游基线违规数，只要求**不新增**。

## 9. 许可

MIT（`LICENSE`，Copyright (c) 2026 CWing）。分发时必须保留版权与许可声明，并保留 `THIRD_PARTY_NOTICES.md` 的第三方声明义务。"OpenBitFun" 是上游品牌——当前选择沿用不改，若将来对外分发建议改名（touchpoint 清单见下）。

## 10. 品牌改名 touchpoint（备用，尚未执行）

- `app/build.gradle.kts`：`applicationId`（L32）、debug 后缀 `.debug`（L56 区）、`namespace`（L27）
- `app/src/main/res/values/strings.xml:4` **和** `values-zh/strings.xml:4` 的 `app_name` —— 规则 8 强制两个 key 集合完全同步，必须一起改（`app_name` 在 `untranslatedByDesign` 白名单，可同值）
- launcher mipmaps（`res/mipmap-*`）、`res/values/themes.xml` 的 `Theme.OpenBitFun`、`ui/theme/Theme.kt`
- `ui/shell/` 下 `StartupBrandReveal.kt`、`WelcomeBrandFlow.kt`、`WelcomeHome.kt`、`OpenBitFunCompactDrawer.kt`
- `AndroidManifest.xml:30` 的深链 scheme —— 改了就撞上第 1 节说的上游白名单，慎之

UI 层的缝已核实：`app` 只依赖 **一个** 共享模块 `com.openbitfun.mobile:core-feature`（`build.gradle.kts:78`），跨缝只走 UiState / Intent。自研 UI 只许动 `app/src/main/kotlin/**/ui/**` 与 `res/**`；会话历史分页、审批 mailbox、`host_stream_v1`/`STREAM_EVENT_GAP`、终端 PTY 游标这些语义**不得在 UI 层重实现或绕过**。
