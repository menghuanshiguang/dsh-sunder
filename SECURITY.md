# 安全策略（Security Policy）

`dsh-sunder` 是一个会**改写系统提示词**、会**联网**、并且能**写本机文件**的 DSH bundle。
它跑在用户自己的机器上、由用户显式安装并启用，所以这里把"它到底能做什么"写清楚，
再说怎么报问题。

## 支持范围

| 版本 | 状态 |
| --- | --- |
| 1.2.x（当前） | 接收安全报告与修复 |
| 1.1.x / 1.0.x | 只处理安全问题；建议直接升到 1.2.0 |
| 0.x | 不再维护 |

环境要求：Node `>= 18`，DSH `>= 0.2.1-rc.1`（见 `package.json` 的 `engines`）。
不在 Windows 上跑的部署没有测试覆盖，报告时请写明平台。

## 威胁模型

### 1. 它会改写本机 system prompt

启用后，插件通过 DSH 的 `systemPrompt` 服务注册三段文本：

| 段 | order | 作用 |
| --- | --- | --- |
| `sunder:identity` | `-100000` | 身份声明，排在整个提示词最前 |
| `sunder:rules` | `9600` | 运行规则，排在工具段之后 |
| `sunder:footer` | `10300` | 收尾指令，排在 persona 后缀之后 |

也就是说：**装了就等于用户授权在本机覆盖出厂的内容策略**，这是产品本身的目的，
不是漏洞。任何一轮请求都会带上这三段（预设在配置里切换，见 `docs/PROMPTS.md`）。

### 2. 它会联网，远端内容会进入上下文和 UI

唯一的出网点（`lib/net.js`，只发 GET，带超时）：

| 用途 | 端点 |
| --- | --- |
| 公告 feed | `https://raw.githubusercontent.com/menghuanshiguang/dsh-sunder/main/announcements.json` |
| 公告镜像 | GitHub contents API（`/repos/:owner/:repo/contents/announcements.json`）、`https://ghproxy.net/https://raw.githubusercontent.com/...` |
| 公告（自定义） | 配置键 `feedUrl` / `feedMirrors` 指定的地址；`builtinMirrors: false` 可关掉内置镜像 |
| 版本检查 | `https://api.github.com/repos/menghuanshiguang/dsh-sunder/releases/latest`，无 release 时退到 `/tags` |
| 自更新下载 | `api.github.com` 的 `tarball_url` / `zipball_url` / `/tarball/:tag` / `/zipball/:tag`（会 302 到 codeload），逐文件兜底走 `/git/trees/:ref?recursive=1` 与 `/git/blobs/:sha` |

风险面：

- **公告正文会进运行时上下文**（"未读公告"段）和浏览器横幅。feed 是远端 JSON，
  被投毒/被劫持的 feed（或用户自己填的 `feedMirrors`）可以把任意文本塞进模型上下文，
  也可以把 `link` 指向钓鱼站。缓解：只用官方 feed 或可信镜像；`feedUrl` 指到自己的地址；
  版本区间（`minVersion` / `maxVersion`）、`level`、`announceLimit` 过滤与条数上限都生效；
  断网时退回随包的 `announcements.json`。
- **公告里的 `link` 会被当 URL 打开**，插件不对域名做白名单校验——打开前自己看清。

### 3. `sunder_update action="apply"` 会写安装目录

`applyUpdate()` 会把下载到的源码包写进**当前安装目录**。用 `link:`（或 `scripts/install.mjs`
建的 junction）挂载时，安装目录就是仓库工作区，所以这个动作会直接改写那份 checkout。
写盘前会先快照到 `$DSH_HOME/sunder/backups/<时间戳>-v<版本>`，但**快照是备份，不是回滚保护**：
没有自动回滚，也不校验下载内容的签名。不想被改写就用 tarball 安装，或先把工作区提交干净。

### 4. 其它本地写入点

| 位置 | 谁写 |
| --- | --- |
| `$DSH_HOME/sunder/state.json` | 已读公告 id、feed/更新缓存、`installId`（本地随机串，不外发） |
| `$DSH_HOME/sunder/backups/` | `applyUpdate()` 的快照 |
| `<profile>/package.json` + `package.json.bak-<时间戳>` | `scripts/install.mjs` / `uninstall.mjs` |
| `<profile>/node_modules/dsh-sunder` | 安装脚本（junction，或退化为副本） |
| 浏览器 `localStorage` | `dsh-sunder.acked` / `dsh-sunder.dismissed` / `dsh-sunder.cache` |

## 安全设计

- **不插值**：三段提示词都带 `interpolate: false`，正文里没有 `{{var}}` 模板占位符，
  所以远端内容、语言名、版本号都不会被当成模板二次展开；插件文本原样进提示词。
  用户想加内容只有一条路——配置键 `extraPrompt`，拼在规则段尾部，且是用户自己写的。
- **包名校验**：`applyUpdate()` 解压（或逐文件拉取）后读结果的 `package.json`，
  只有 `name === "dsh-sunder"` 才落盘；已安装目录的 `package.json` 若声明了别的包名，
  整体放弃；"已是最新"时不动任何文件；任何失败都返回 `{ ok: false, error }`，不抛给宿主。
- **安装脚本防御**：先校验目标 `package.json` 的字段类型（非对象就整体放弃）；
  `node_modules/dsh-sunder` 属于另一个包（既不是指向本仓库的链接，也不是同名副本）时拒绝覆盖；
  `-n` / `--dry-run` 不写盘、不建备份；改 `package.json` 前留 `package.json.bak-<时间戳>`。
- **客户端只读**：`lib/client.js` 拿不到 host 端配置，也不改写插件状态，只写自己的 localStorage 键。
- **无遥测**：没有分析、没有心跳、没有埋点，也没有 POST；出网只有上面那张 GET 清单。
  `installId` 只落在本地 `state.json`，不参与任何请求。
- **零依赖**：`dependencies` / `peerDependencies` 为空（`scripts/check-package.mjs` 会强制这一条），
  不引入第三方传递依赖，也就不继承它们的供应链风险。
- **诊断只读**：`scripts/doctor.mjs` 不建目录、不改 `package.json`、不动 `state.json`，
  也不触发安装或更新。

## 不算安全问题（设计使然）

- 提示词覆盖内容策略、模型因此不再拒绝某些请求——这就是插件的功能。
- 公告/更新请求本身（域名、请求头、频率都在上面列清了）。
- `applyUpdate` 改写了 `link:` 挂载的 checkout——已有文档说明，用 tarball 安装即可避开。
- 本机用户改自己的 `localStorage` 或 `state.json`（已读/关闭状态归用户所有）。

## 报告漏洞

**请走 GitHub Security Advisory**（私密通道）：
<https://github.com/menghuanshiguang/dsh-sunder/security/advisories/new>

- 低风险、且不涉及可利用细节的问题（文档错误、防御性建议）可以直接开 issue：
  <https://github.com/menghuanshiguang/dsh-sunder/issues>
- **不要在公开 issue 里贴可利用细节**：能稳定注入上下文的最小 feed/PoC、本地绝对路径、
  任何凭据或 token 都不要发。等修复发布后再公开讨论。

报告里请带上：

1. 版本（`sunder_status` 的 `version=` 或 `npm run doctor` 头部）；
2. 平台与 Node 版本；
3. `npm run doctor -- --json` 的输出（先把 `$DSH_HOME`、用户名等本地路径抹掉）；
4. 复现步骤、期望行为与实际行为、影响范围（比如"能往上下文注入任意指令"）。

处理节奏：尽力在 7 天内给出首次回复；确认后在 `CHANGELOG.md` 的 `Fixed` / `Security` 段记录并
发布补丁版本（1.x 内保持向后兼容）。修复发布前请不要公开细节；没有固定的保密期限要求。
