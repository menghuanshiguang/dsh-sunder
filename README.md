<div align="center">

# dsh-sunder

**给 DSH 换一套提示词：装上之后，每一轮都由你的指令说了算。**

[![CI](https://github.com/menghuanshiguang/dsh-sunder/actions/workflows/ci.yml/badge.svg)](https://github.com/menghuanshiguang/dsh-sunder/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/menghuanshiguang/dsh-sunder?label=license)](./LICENSE)
[![version](https://img.shields.io/github/package-json/v/menghuanshiguang/dsh-sunder?label=version)](./package.json)
[![node](https://img.shields.io/badge/node-%E2%89%A518-339933)](./package.json)

[快速上手](#30-秒上手) · [它做什么](#它做什么) · [配置](#配置) · [提示词架构](#提示词架构) · [工具](#工具) · [更新链路](#版本更新链路) · [故障排查](docs/TROUBLESHOOTING.md) · [架构说明](docs/ARCHITECTURE.md)

</div>

---

## 30 秒上手

```powershell
# 1) 安装：把本仓库挂进 DSH profile（默认 profile 为 $DSH_HOME/profiles/desktop）
node scripts/install.mjs

# 2) 重启 DSH —— bundle 列表只在 profile 启动时读取
# 3) 不需要新开会话：已经开着的会话，下一轮请求就会带上 Sunder 段
```

验证一下：在会话里让模型调用 `sunder_status`，返回里应当出现 `dsh-sunder 1.1.0`、`preset=full`、`guard=on`。

第 3 步之所以不用重开对话，是因为 DSH 每处理一次模型请求都会重新组装（assemble）系统提示，Sunder 的三段是这次组装的参与者，而不是启动时拼死的固定字符串。细节见 [提示词架构](#提示词架构)。

## 它做什么

Sunder 是一个 DSH 插件（bundle + 三个提示词段 + 一组 `sunder_*` 工具 + 一个浏览器端状态卡片 + 一个状态文件）：

1. **覆盖默认身份与内容策略**：注册 `sunder:identity`、`sunder:rules`、`sunder:footer` 三段，分别占据系统提示的第一段、工具段之后、以及整份提示的最后一段；规则段有 `full` / `concise` / `dev` 三档预设可换。
2. **关掉宿主的身份段**：bundle patch 把 `system-prompt` 的 `includeHarnessIdentity` 置为 `false`，避免默认身份声明与 Sunder 段互相打架。
3. **防止被别的插件顶掉**：给 `systemPrompt.assemble` 装一层访问器守卫（guard），任何一次组装之后都补齐缺失的 `sunder:*` 段；守卫失效时还有 `system-prompt/assemble` waterfall 兜底。
4. **公告中心**：从远端 feed 拉公告，镜像链兜底，网络不通时用随包的 `announcements.json`；未读公告以运行期上下文的形式进入当轮提示，也可以逐条确认。
5. **更新检查与安装**：查 GitHub Releases，缓存 6 小时，发现新版本时在当轮提示里带一句提醒；需要时用 `sunder_update action=apply` 直接装上（先快照、校验包名，再写安装目录）。
6. **可观测**：`sunder_status` / `sunder_config` / `sunder_prompt` 三个工具把版本、生效配置和最终提示词文本摊开给你看；DSH 设置页还有一个只读的 `Sunder` 分区与未读公告横幅。所有持久化数据都在一个 JSON 文件里。

## 它不做什么

- **不改 DSH 源码、不动你的项目**：不 patch DSH 本体，不扫描项目，不写项目目录里的文件。唯一的写盘例外是你显式调用 `sunder_update action=apply`——它只改写插件自己的安装目录（用 `link:` 或安装脚本挂载时，那个目录就是本仓库的 checkout，见[安全声明](#安全声明)）。
- **不提权、不绕过审批**：工具调用、文件读写、沙箱与审批策略仍然由 DSH 决定。Sunder 换的是"内容层"的提示词，不是权限。
- **不是模型、不是聊天客户端、不转发流量**：它只是一个插件。出站 GET 只有公告 feed 与 GitHub Releases 检查两类（都能关）；只有在你显式执行 `action=apply` 时，才会去下载本插件自己的源码包。
- **面板不是控制台**：随包的浏览器端卡片只读——它显示状态、公告和版本结论，不让你在面板里改配置，也不写宿主状态。改配置仍然是编辑 `cordis.patch.yml` 再重启。
- **不隐身**：它显式地改系统提示，DSH 自己的日志、历史与 `sunder_status` 都看得到。
- **不把公告当代码**：公告是纯文本，只做字符串投影；更新检查只比较版本号并给出链接。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| DSH | 0.2.1-rc.2（开发与测试基准）；更早版本没有 `systemPrompt` 服务 |
| Node.js | `>=18`（`package.json` 的 `engines`）；CI 覆盖 20 与 22 |
| 平台 | Windows / macOS / Linux（CI 在 Windows 上跑） |
| 包管理器 | 安装脚本不依赖包管理器；手动安装需要 `npm` 或 `pnpm` 建立 `link:` 依赖 |

## 安装

### 方式一：一键脚本（v1.1.0 新增）

在仓库根目录执行：

```powershell
node scripts/install.mjs                        # 安装到 $DSH_HOME/profiles/desktop
node scripts/install.mjs -p D:\some\profile     # 指定其它 profile（也接受 --profile=<目录>）
node scripts/install.mjs --repo D:\other\clone  # 指定插件仓库（默认本脚本所在的仓库）
node scripts/install.mjs --dry-run              # 只看计划，不写任何文件（别名 -n）
node scripts/install.mjs --uninstall            # 卸载（等价于 scripts/uninstall.mjs，别名 -u）
node scripts/install.mjs --help                 # 打印用法（别名 -h）
```

脚本做三件事，并且**每一步都可重复执行**（无变化时不写文件）：

1. 在 `<profile>/node_modules/dsh-sunder` 建 junction 指向本仓库；没有建链接的权限时自动退化为复制目录；该目录属于别的包时直接报错退出，不覆盖；
2. 在 `<profile>/package.json` 的 `dependencies` 写入 `"dsh-sunder": "link:<仓库路径>"`；
3. 把 `dsh-sunder` 追加到 `dsh.profile.bundles`，并**只从列表里摘掉** `dsh-purge` / `dsh-purge-cwd-compat` 两个条目（包本体保留不删）。

改 `package.json` 之前一定会先写 `package.json.bak-<时间戳>`；成功输出里会打印目标 profile、依赖变化、bundles 变化、`node_modules` 链接动作和备份路径，退出码 `0` 成功、`1` 失败、`2` 参数错误。最后一行会提示你重启 DSH。

> 两个脚本随仓库发布，**不在 npm tarball 里**（`package.json` 的 `files` 未包含 `scripts`），所以请从 clone 出来的仓库里运行它们；纯 npm 包安装的话走下面的方式二或方式三。

### 方式二：手动挂到 profile

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-sunder": "link:D:/dsh/sunder"   // 或 "file:C:/path/dsh-sunder-<version>.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        // …其它 bundle…
        "dsh-sunder"
      ]
    }
  }
}
```

然后在 profile 目录里 `npm install`（或 `pnpm install`），确认 `node_modules/dsh-sunder` 指向仓库，再重启 DSH。顺序有意义：bundle 按数组顺序叠层，`dsh-sunder` 放最后，它的 patch 才能覆盖前面的行。

### 方式三：离线 tarball

```powershell
npm pack                       # 在仓库根目录生成 dsh-sunder-<version>.tgz
# 把 tgz 拷到目标机器，profile 里改用 "dsh-sunder": "file:/abs/path/dsh-sunder-<version>.tgz"
```

### 安装后确认

- DSH 启动日志里有 `[dsh-sunder] v1.1.0 active — language=zh, preset=full, prompt sections registered, guard=on`；
- 会话里调用 `sunder_status`，能看到 `placements=sunder:identity@-100000,sunder:rules@9600,sunder:footer@10300`；
- 状态文件出现在 `$DSH_HOME/sunder/state.json`。

## 配置

插件配置写在 profile 的 `cordis.patch.yml`（或 `--patch` 指定的文件）里 `id: sunder` 那一行；没写的键使用插件内的默认值。

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false   # 关掉宿主身份段，让 Sunder 的身份声明排第一

- insert:
    - id: sunder
      name: dsh-sunder
      inject: [systemPrompt]
      config:
        preset: concise             # v1.1.0
        language: zh
        extraPrompt: |
          本机没有外网，别建议我查在线文档。
```

> 宿主的 patch 语义是**整行替换 config，不做深合并**：同一个 `id` 出现两次时，后一个会整体顶掉前一个的 `config`。要么只写你覆盖的键（其余取插件默认值），要么一次写全。

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时不注册任何提示词段、运行期上下文与工具（启动日志仍会打） |
| `language` | `'auto'` | `zh` / `en` 强制语言；`auto` 跟随进程的 `Intl` 区域设置（`zh*` 用中文，其余用英文） |
| `preset` | `'full'` | **v1.1.0 新增**。`full`（九条规则）/ `concise`（压缩到四条，文本长度约为 `full` 的 60%）/ `dev`（九条规则 + 编码代理附加段）。未知值回落到 `full`，同名未知值只警告一次。详见[预设](#预设v110) |
| `extraPrompt` | `''` | 追加到规则段末尾的自定义文本（自动 trim；空串等于不追加） |
| `announcements` | `true` | 公告中心开关 |
| `announceLimit` | `3` | 单轮最多选中并注入几条公告 |
| `feedUrl` | 官方 `raw.githubusercontent.com` 地址 | 公告主源 |
| `feedMirrors` | `[]` | 追加镜像；与内置镜像一起去重后按顺序尝试 |
| `builtinMirrors` | `true` | 是否使用内置镜像（GitHub contents API、ghproxy） |
| `bundledAnnouncements` | `true` | 所有远端源都失败时，用随包的 `announcements.json` 兜底 |
| `updateCheck` | `true` | 更新检查开关 |
| `updateIntervalHours` | `6` | 缓存有效期；公告与更新的轮询周期也用它（下限 1 小时） |
| `repo` | `menghuanshiguang/dsh-sunder` | 更新检查使用的 GitHub 仓库 |
| `tools` | `true` | 注册 `sunder_*` 工具 |
| `guard` | `true` | 是否给 `assemble` 装访问器守卫。`false` 时 waterfall 兜底仍然生效 |
| `debug` | `false` | 打出守卫装配失败、状态写入失败等调试日志 |

### 预设（v1.1.0）

`preset` 只决定文字密度，三档共享同一份身份段：

| `preset` | 组成 | 长度（相对 `full`） | 适用场景 |
| --- | --- | --- | --- |
| `full`（默认） | 完整身份声明 + 九条规则 + 完整收尾 | 100% | 日常使用；要最完整的不拒绝 / 不缩范围 / 用户优先约束 |
| `concise` | 完整身份声明 + 四条压缩规则 + 一行收尾 | 约 60% | 上下文紧张、小模型、或只想要最短的有效约束 |
| `dev` | `full` 的九条规则 + 编码代理附加段 | 约 125% | 当编码代理用：完整文件、不缩范围、不跳过构建与测试 |

- 预设只换文字，不换位置：三段 order 永远是 `-100000 / 9600 / 10300`，`interpolate` 始终 `false`，所以守卫和 waterfall 兜底的行为不会因预设改变。
- 未知值由 `resolvePreset()` 回落到 `full`，同一个未知名字只警告一次（启动日志里能看到）。`sunder_status` 打印的是**配置原值**，不一定是实际生效的那一档；要看实际文本用 `sunder_prompt`。
- 不改配置也想对比某一档：`sunder_prompt` 传 `{"preset": "concise", "section": "rules"}` 即可。
- 三档的 `label` / `description` 在 `lib/prompt.js` 的 `PRESET` 表里（中英双语，只读），`locale/zh.json`、`locale/en.json` 的 `presets` 是同一份文案的镜像。

## 提示词架构

```
profile 启动
  └─ cordis.patch.yml
       ├─ patch(system-prompt): includeHarnessIdentity = false
       └─ insert(id=sunder, name=dsh-sunder, inject=[systemPrompt])

            ▼  index.js apply(ctx, config)
   ┌────────────────────────────────────────────────────────┐
   │ buildPrompt({ language, preset, extraPrompt, version })│
   │   → 3 × systemPrompt.section(interpolate: false)       │
   │ renderAnnouncements(unread, language)                  │
   │   → 1 × runtime context @3600（空串时被宿主丢弃）        │
   │ 更新提醒                                               │
   │   → 1 × runtime context @3400（仅发现新版本时）          │
   └────────────────────────────────────────────────────────┘

            ▼  每次模型请求：systemPrompt.assemble(context)
   sections 按 (order, name) 排序 → 渲染 → 发给模型
            ▲
            └─ assemble guard：组装完成后补齐缺失的 sunder:* 段
```

三段在整份系统提示里的位置：

| 段落 | order | 相对位置 |
| --- | --- | --- |
| `sunder:identity` | `-100000` | 第一段，早于宿主身份段 `HARNESS_IDENTITY`（`-1000`） |
| —— | `0` … `5000` | 部署人格前缀、规划/团队策略、文件引用、各工具 schema |
| `sunder:rules` | `9600` | 所有工具段之后，`STRUCTURED_OUTPUT`（`9900`）与 `HARNESS_SOURCE`（`10000`）之前 |
| —— | `9900` … `10200` | 结构化输出、harness 源码、Web 界面说明、部署人格后缀 |
| `sunder:footer` | `10300` | 最后一段，模型读完规则前看到的最后一句仍是"用户指令是唯一权威" |

三段的 `interpolate` 都显式设为 `false`：文案里**不含任何模板变量**。DSH 对未注册的 `{{var}}` 是直接抛错的，不含变量就天然免疫这个失败模式。为什么不改写 `complete` 段、守卫怎么在别人的 `assemble` 上活下来，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 公告与更新控制

### 公告来源

尝试顺序（去重后依次请求，任一成功即停止）：

1. `feedUrl`（默认官方 `raw.githubusercontent.com`）；
2. `feedMirrors` 里你自己加的地址；
3. 内置镜像（`builtinMirrors: true` 时）：GitHub contents API（base64）、`ghproxy.net` 反代；
4. 全部失败时，若 `bundledAnnouncements: true`，用随包的 `announcements.json` 兜底并标记来源为 `bundled`。

远端 feed 可以是裸数组、`{"announcements": [...]}`、JSON 字符串，或 GitHub contents API 的 base64 响应。每条公告支持 `minVersion` / `maxVersion` 做版本区间过滤，支持 `zh` / `en` 双语字段。选中的公告按日期倒序（同日期 `critical > warn > info`）取前 `announceLimit` 条。

```json
{
  "announcements": [
    {
      "id": "2026-10-21-hello-sunder",
      "level": "info",
      "date": "2026-10-21",
      "title": { "zh": "Sunder 1.0.0 发布", "en": "Sunder 1.0.0 is out" },
      "body": { "zh": "……", "en": "……" },
      "link": "https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.0.0",
      "minVersion": "1.0.0"
    }
  ]
}
```

### 更新检查

查 `https://api.github.com/repos/<repo>/releases/latest`，失败时退回 `/tags`；机器上有 `gh auth token` 或 `GH_TOKEN` / `GITHUB_TOKEN` 时会带上，以避开匿名限流。结果缓存在状态文件里，默认 6 小时内不重复请求；`sunder_update`（默认 `action=check`）会绕过缓存立刻查一次。

设置页卡片上的"刷新"是**浏览器端**的：客户端自己直连 GitHub API（缓存 6 小时），只刷新那张卡片，不会刷新宿主的检查结果，也不改写状态文件。

**安装更新**（v1.1.0，`sunder_update action=apply`）：解析 latest → 下载源码包（zip / tar.gz）→ 失败则退到 GitHub contents API 逐文件拉取 → **解压结果里 `package.json.name === "dsh-sunder"` 之后**才写进安装目录；写盘前先把当前安装快照到 `$DSH_HOME/sunder/backups/<时间戳>-v<版本>`。已经是最新版本时什么都不改（`method=up-to-date`，没写成时连快照都会删掉）；任何失败都返回 `{ ok: false, error }` 而不是抛异常。装完仍需重启 DSH。

`action=apply` 是显式动作，**不受 `updateCheck: false` 影响**——那个开关只关掉后台检查和 `action=check`。

```text
> sunder_update {"action": "apply"}
action=apply
applied=yes
from=1.0.1
to=1.1.0
target=<安装目录>
method=<zip|tgz|contents-api>
files=42
backup=<DSH_HOME>/sunder/backups/2026-10-21T14-03-12-345Z-v1.0.1
restart=required
note=新文件已写入安装目录，重启 DSH 后生效。
```

`method` 是这次用的通道（源码包类型或 `contents-api`）；失败时多出 `error=<错误码>` 与可选的 `detail=`，`note` 是本地化说明。常见错误码：`not-a-sunder-install`（目标目录是别的包）、`package-name-mismatch`（下载内容不是 `dsh-sunder`）、`download-unavailable`（`api.github.com` / `codeload` 被挡）、`extract-failed`、`tree-truncated` / `incomplete-download`（contents API 兜底不可用）。

### 关掉它们

```yaml
config:
  announcements: false    # 不拉公告、不注入未读摘要（sunder_notice 仍可查历史确认记录）
  updateCheck: false      # 不查更新：后台不轮询，sunder_update action=check 回 "update check is disabled"
```

`updateCheck: false` 只关检查和后台轮询；显式 `sunder_update action=apply` 仍然会去下载，因为那是你自己按下去的动作。

只想关掉"进提示"、保留拉取记录：`announceLimit: 0`——公告照拉、照记更新时间，只是不进当轮提示（`sunder_status` 里显示 `announcements=on (unread 0)`）。

## 工具

| 工具 | 用途 | 参数 |
| --- | --- | --- |
| `sunder_status` | 一行式状态：版本、语言与 `preset=`（配置原值）、开关、公告未读、段位、feed 与来源 / 错误、更新结论、状态文件路径、repo | 无 |
| `sunder_notice` | 列出 / 确认公告 | `action`（`list` / `ack` / `ack-all`），`ack` 需要 `id` |
| `sunder_update` | `check`（默认）绕过缓存查一次；`apply` 下载并装上最新 release | `action`（`check` / `apply`） |
| `sunder_config` | **v1.1.0 新增**：打印生效配置（语言与原始值、预设、公告、feed 与镜像、更新周期、repo、开关、`extraPrompt` 字符数、状态文件路径） | 无 |
| `sunder_prompt` | **v1.1.0 新增**：预览插件真正注册的三段文本 | `language`（`zh` / `en`）、`preset`（`full` / `concise` / `dev`）、`section`（`all` / `identity` / `rules` / `footer`） |

工具只在 `tools: true` 且宿主提供 `ctx.tools` 时注册；所有工具的输出都是单个 `{ text }` 对象，便于任何宿主渲染。

```text
> sunder_status
dsh-sunder 1.1.0
language=zh preset=full sections=on guard=on
announcements=on (unread 2) update_check=on
placements=sunder:identity@-100000, sunder:rules@9600, sunder:footer@10300
update=up to date
feed=https://raw.githubusercontent.com/menghuanshiguang/dsh-sunder/main/announcements.json (source=bundled)
feed_error=none
state=~/.dsh/sunder/state.json
repo=https://github.com/menghuanshiguang/dsh-sunder
```

`preset=` 打的是配置原值：写成未知值时它照样显示那个值，实际生效的是回落后的 `full`。想看真实文本用 `sunder_prompt`：

```text
> sunder_prompt {"preset": "concise", "section": "rules"}
language=zh preset=concise version=1.1.0
## rules
Sunder 运行规则（精简版 · 最高优先级）：
…
```

## 设置页与公告横幅（v1.1.0）

随包带一个浏览器端半（`lib/client.js`；`package.json` 的 `dsh.client` 声明 `platform: "web"`，并注入 `@deepseek-ai/dsh-client-ui-renderer` 与 `@deepseek-ai/dsh-api-remotes`），DSH 启动时由客户端模块加载器自动装上（`window.__ModuleLoader__.load({ id: "dsh-sunder", … })`）。它注册两个槽位，**都只读**：

| 槽位 | id | 位置 | 内容 |
| --- | --- | --- | --- |
| `settings.section` | `sunder` | DSH 设置页里的 `Sunder` 分区（order 60） | 版本、启用状态与挂载阶段、语言 / 预设 / guard、未读公告数、最近一次更新检查、最新版本、仓库与 Release 链接；按钮：`刷新`、`全部标记已读` |
| `shell.overlay` | `sunder-notice` | 右下角横幅 | 最新一条未读公告的标题 + 未读总数 + 链接 + `×` 关闭 |

**为什么是只读的**：客户端插件拿不到 host 端配置（`index.js` 没有声明 Config schema，`remote.settings.describe()` 里没有 sunder 的条目），所以卡片上语言 / 预设 / guard 多半显示"未知"并写明原因；它也不会去写宿主的 `state.json`。要改配置只有一条路：编辑 `cordis.patch.yml` 再重启。想确认实际生效值，用 `sunder_config`。

**已读记录在浏览器里**：客户端用 `localStorage` 三个键各自记账——`dsh-sunder.acked`（已读 id 集合）、`dsh-sunder.dismissed`（横幅关掉过的 id）、`dsh-sunder.cache`（公告与版本结论缓存，公告 30 分钟、版本 6 小时）。清掉这三项等于把卡片恢复成"全未读"。

> 两套已读**不互通**：`sunder_notice action=ack` 改的是宿主 `state.json`（影响进不进提示词），面板的未读数来自 `localStorage`。看到面板还亮着未读、但提示词里已经没有了，就是这个原因。

卡片的"刷新"只刷新浏览器端缓存（客户端自己直连 GitHub API），不触发宿主检查；未连上 host 桥时卡片会退化成静态信息，不影响插件本身。

## 状态文件

路径：`$DSH_HOME/sunder/state.json`（`DSH_HOME` 未设置时是 `~/.dsh`）。写入方式是"临时文件 + rename"，失败只记日志、从不抛错。

| 字段 | 说明 |
| --- | --- |
| `schema` | 状态结构版本，当前为 `1` |
| `installId` | 首次运行生成的 UUID，用来在公告里区分安装 |
| `firstRunAt` | 首次运行时间 |
| `lastUpdateCheck` | 最近一次更新检查：`{ checkedAt, latest, url, publishedAt, newer }`；检查失败时是 `{ checkedAt, error }` |
| `seenAnnouncements` | `{ id: ISO 时间 }`，每条公告第一次被选中时记录 |
| `ackedAnnouncements` | 已确认的公告 id 列表；`ack` 后不再进入当轮提示 |
| `lastAnnouncementCheck` | 最近一次成功拉取公告的时间 |

删掉这个文件等于重置"已读/已确认"与缓存，插件会重新生成。

## 版本更新链路

一条版本从 tag 走到你机器上的顺序：

1. `scripts/release.mjs` bump `package.json` 与 CHANGELOG、commit、打 `v*` tag、push，release workflow 据此建 GitHub Release（资产就是这个仓库的源码包）。
2. 公告：仓库根的 `announcements.json` 既是 feed 主源、也是随包兜底；新版本发出去时补一条 `minVersion` 对应的条目，`feedUrl` / `feedMirrors` / 内置镜像 / bundled 依次兜底。
3. 宿主侧：`sunder_update action=check` 或后台轮询（`updateIntervalHours`，默认 6 小时）查 Releases；发现新版本时下一轮提示里多一句提醒，`sunder_status` 的 `update=` 也变。
4. 你决定装：会话里 `sunder_update action=apply`（快照 → 下载 → 校验包名 → 写入 → `restart=required`），或者 `git pull` 后跑一次 `node scripts/install.mjs`，或者用新 tarball 重新挂。
5. 重启 DSH 后新 bundle 列表才加载：`sunder_status` 的版本号、设置页卡片、启动日志三处会同时变。

几个边界：

- `apply` 只搬文件，不重启 DSH，也不跑 `npm install`。
- 用 `link:` / junction 挂载时，第 4 步写的就是本仓库工作区；`git pull` 和 `apply` 别同时来，否则互相盖。
- 卡片上的"最新版本"是浏览器直连 GitHub 的结果，时间戳和宿主缓存不一定同步。

## 卸载

```powershell
node scripts/uninstall.mjs                        # v1.1.0：独立的卸载入口
node scripts/install.mjs --uninstall              # v1.1.0：同一个逻辑，从 install 脚本进
node scripts/uninstall.mjs -p D:\some\profile     # 指定 profile；--repo 同样可用
node scripts/uninstall.mjs --dry-run              # 只看计划，不写文件（别名 -n）
```

两者做的是同一件事：删 `dependencies` 里的 `dsh-sunder`、从 `dsh.profile.bundles` 摘掉条目、解开 `node_modules/dsh-sunder`（junction 只解链，不跟进删除；是复制出来的目录才删）。`node_modules/dsh-sunder` 若属于另一个包，脚本会跳过它并说明原因。改 `package.json` 前同样留 `package.json.bak-<时间戳>`；仓库本体永远不动。

或手动：

1. 从 `<profile>/package.json` 的 `dsh.profile.bundles` 里删掉 `"dsh-sunder"`；
2. 从 `dependencies` 里删掉 `"dsh-sunder"`；
3. 删掉 `<profile>/node_modules/dsh-sunder`（junction 用 `rmdir`，不要用递归删除工具跟进链接）；
4. 重启 DSH；
5. 可选：删 `$DSH_HOME/sunder/state.json`。

卸载**不会**删你的项目、也不会改动 `announcements.json` 等仓库文件。

## 故障排查

常见症状与处理见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。三个最高频的：

| 症状 | 先看这里 |
| --- | --- |
| 装完没反应、提示词没变 | 是否重启了 DSH（见[为什么必须重启](docs/TROUBLESHOOTING.md#1-装完没有生效)） |
| 旧对话里看不到变化 | 下一轮才生效；仍不行看[第 2 节](docs/TROUBLESHOOTING.md#2-已有对话要下一轮才生效) |
| 报 `unknown prompt variable` | 多半是另一个提示词插件引用了未注册的变量，见[第 3 节](docs/TROUBLESHOOTING.md#3-unknown-prompt-variable-与-dsh-purge-冲突) |

## v1.1.0 新增一览

- **一键安装 / 卸载**：`scripts/install.mjs` / `scripts/uninstall.mjs`（`-p` / `--profile`、`--repo`、`-n` / `--dry-run`、`-u` / `--uninstall`、`-h` / `--help`），幂等、写前备份、目标目录属于别的包时拒绝覆盖。
- **三档预设**：`preset: full | concise | dev`，只换文案不换位置；`sunder_prompt` 可以先看效果再改配置。
- **两个新工具**：`sunder_config`（生效配置）、`sunder_prompt`（最终提示词预览）；`sunder_status` 增 `preset=`。
- **会装更新的 `sunder_update`**：`action=apply` 直接装最新 release——快照 → 下载源码包（失败退 contents API）→ 校验包名 → 写入安装目录；`action=check` 保持原来的只查不装。
- **客户端状态卡片与公告横幅**：随包 `lib/client.js`（`dsh.client.platform = "web"`），DSH 设置页多一个只读的 `Sunder` 分区，右下角弹未读公告；已读与关闭记在浏览器 `localStorage`，配置仍只走 `cordis.patch.yml`。
- **公告源可配**：`feedUrl` / `feedMirrors` / `builtinMirrors` / `bundledAnnouncements`，镜像链与随包兜底都可单独关。

## 开发与测试

```powershell
node test/unit.mjs               # 版本比较、feed 解码、更新缓存、状态文件、网络层（stub fetch）
node test/prompt.mjs             # 三段顺序、预设（full / concise / dev）、interpolate:false、文案不含 {{ 变量
node test/client.mjs             # v1.1.0：客户端插件的注册契约与状态序列化
node test/install.mjs            # v1.1.0：install / uninstall 对 tmpdir 假 profile 的完整流程
node test/update.mjs             # v1.1.0：更新检查与 applyUpdate 的各条成功 / 失败路径
node test/smoke.mjs              # 需要本机 DSH 运行时；找不到会打印 skip 并退出 0
node scripts/check-package.mjs   # 打包契约：exports、files、patch、locale、CHANGELOG 版本段
npm test                         # 按顺序全跑一遍：unit → prompt → client → install → update → smoke → check-package
npm run test:client              # 只跑客户端契约
```

`package.json` 里另有 `npm run install:profile` / `npm run uninstall:profile`（转交两个脚本）和 `npm run release` / `npm run publish:api` / `npm run changelog`。

发布用 `node scripts/release.mjs patch|minor|major|X.Y.Z [--yes] [--dry-run] [--no-push]`，它会 bump 版本、写 CHANGELOG、提交、打 tag、推送并创建 GitHub Release；`node scripts/release.mjs --changelog` 只生成 CHANGELOG 段。

CI 在 `windows-latest` 上跑 Node 20 与 22：`test/unit.mjs`、`test/prompt.mjs`、`test/install.mjs`、`test/update.mjs`、`test/client.mjs` 各一步（文件不存在就跳过），最后跑 `scripts/check-package.mjs`。

## 安全声明

- Sunder 改的是**提示词**，不是权限边界：它不能让你调用本不该调用的工具，也不能绕过 DSH 的审批与沙箱。
- 写盘范围就三处：自己的 `state.json`、`sunder_update action=apply` 时的插件安装目录与 `$DSH_HOME/sunder/backups/` 快照、以及浏览器端 `localStorage`。它不扫描项目、不读无关文件、不碰你的仓库。
- 出站请求：公告 feed 与 GitHub Releases 检查都是 GET，且都能用配置关掉；只有你显式执行 `action=apply` 时才会去下载源码包（`api.github.com` 的发布信息 → `codeload` 源码包 / contents API 逐文件）。
- `applyUpdate()` 只往插件自己的安装目录写，并且要等解压结果的 `package.json.name === "dsh-sunder"` 对上才允许落盘；目标目录属于别的包（`not-a-sunder-install`）、下载失败或包名不符都不会改写现有安装。
- 快照是备份，不是回滚：`apply` 先在 `$DSH_HOME/sunder/backups/<时间戳>-v<版本>` 留一份当前文件，装完要回退得自己拷回去。用 `link:` / junction 挂载时安装目录就是本仓库 checkout，`apply` 会直接改写它。
- 远端内容只当数据：公告是纯文本，不参与任何代码执行；更新检查只比较版本号。真要执行新代码，那是 DSH 的插件加载器在你重启后干的。
- 系统提示被改写这件事本身是可见的：模型看得到，DSH 的历史与日志也看得到。

## 许可证

[MIT](./LICENSE) © menghuanshiguang
