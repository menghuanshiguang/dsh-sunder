# 故障排查

按症状查。每条都给出"怎么确认"和"怎么修"。修完记得重启 DSH——除了明确写着"下一轮生效"的项。

## 快速索引

| 症状 | 跳到 |
| --- | --- |
| 装完提示词没变 / 日志里没有 `[dsh-sunder]` | [1. 装完没有生效](#1-装完没有生效) |
| 已经开着的对话里看不到变化 | [2. 已有对话要下一轮才生效](#2-已有对话要下一轮才生效) |
| 报错 `unknown prompt variable` / `prompt section "…" is already registered` | [3. unknown prompt variable 与 dsh-purge 冲突](#3-unknown-prompt-variable-与-dsh-purge-冲突) |
| 公告拉不下来、一直显示随包那条 | [4. 公告源被墙](#4-公告源被墙) |
| `sunder_status` 里更新一栏是 `error` | [5. 更新检查 403 与限流](#5-更新检查-403-与限流) |
| 想退回去、装坏了 | [6. 回滚与卸载](#6-回滚与卸载) |
| 要提 issue | [7. 怎么收集诊断信息](#7-怎么收集诊断信息) |

---

## 1. 装完没有生效

**症状**：DSH 起来了，但提示词没变；`sunder_status` 工具不存在；启动日志里找不到 `[dsh-sunder] v… active`。

**原因**：bundle 列表和插件模块只在 profile **启动**时读取一次。

- `dsh.profile.bundles` 是启动时组装的，改完必须重启才生效；
- DSH 的 `hmr` 插件默认只热更**配置层**（`config.root: []`，模块根目录是 opt-in），新装或改过代码的 bundle 不在这条热更链上。

**确认**：

```powershell
# a) bundle 在不在
Get-Content "$HOME\.dsh\profiles\desktop\package.json" | Select-String 'dsh-sunder'

# b) node_modules 里的链接指向哪
Get-Item "$HOME\.dsh\profiles\desktop\node_modules\dsh-sunder" | Select-Object LinkType, Target
#   期望：LinkType=Junction, Target=<你的仓库路径>
```

如果 profile 不在默认位置，用 `$env:DSH_HOME` 拼路径（`$env:DSH_HOME\profiles\<名字>`）。

**修**：

1. 完全退出 DSH（不是最小化，进程要结束），再启动；
2. 还是没有 → 重跑一次安装脚本，它会打印目标 profile 与每一步的结果：

   ```powershell
   node scripts/install.mjs --dry-run    # 先看计划
   node scripts/install.mjs              # 再执行（幂等，可重复跑）
   ```

3. 脚本报"找不到 profile 的 package.json" → 用 `--profile <目录>` 指定真实 profile；
4. 启动日志里出现 `error` 而不是 `[dsh-sunder]` → 看 [第 3 节](#3-unknown-prompt-variable-与-dsh-purge-冲突) 或把日志贴进 issue。

> `enabled: false` 也会让插件"看起来没装"：它照样加载、照样打启动日志，只是不注册任何段和工具。用 `sunder_status` 看不到时，先确认 `guard`/`enabled` 两个开关。

## 2. 已有对话要下一轮才生效

**症状**：插件装好了，当前对话还是老样子；新开一个对话就正常。

**结论**：这是设计行为，不用修。

DSH 每处理一次模型请求都会重新 `assemble` 系统提示，Sunder 的三段是这次组装的参与者。所以：

- 已经开着的对话，**下一轮请求**就会带上新段，不需要重开；
- 历史里的旧消息不会回溯改写（`systemPromptUpdate: 'in-history'` 只决定"变化怎么进入历史"，不重写过去）；
- 如果"下一轮"之后仍旧没变化，那就不是缓存问题，回到 [第 1 节](#1-装完没有生效) 看插件是否真的加载了。

**一个容易混淆的点**：别的插件注册了 `complete: true` 段时，宿主的 `assemble` 只返回那一段——你会觉得"Sunder 没生效"，其实是被顶掉了。Sunder 的 guard 会把三段补回去，但只在 guard 或 waterfall 至少有一条活着时（见 [ARCHITECTURE](./ARCHITECTURE.md#3-assemble-guard-的生命周期)）。

## 3. unknown prompt variable 与 dsh-purge 冲突

**症状**：

```
Error: unknown prompt variable "xxx" (registered: …)
```

或者：

```
prompt section "sunder:identity" is already registered
```

**原因**有两类：

1. **别的提示词插件引用了一个没注册的变量。** DSH 的插值很严格：`{{var}}` 找不到注册项就直接抛错，整轮系统提示都拿不到。Sunder 自己三段都是 `interpolate: false`，文案里没有变量，所以报错几乎总是来自**另一个**插件。
2. **两个提示词包里存在同名段。** `dsh-sunder` 与 `dsh-purge` 都是"完整提示词包"，同时启用时容易互相覆盖或撞名。

**确认**：

- 看报错里的变量名，用 `dsh-purge`、`dsh-sunder` 之一去仓库里搜它的注册点；错误里列出的 `registered: …` 就是当前真正注册过的变量名；
- 会话里跑 `sunder_status`：`placements=` 一栏应当有 `sunder:identity@-100000,sunder:rules@10150,sunder:footer@10300`。缺哪段，就说明它没进组装。

**修**：

1. **只留一个提示词包。** `scripts/install.mjs` 在追加 `dsh-sunder` 的同时，会从 `dsh.profile.bundles` 里摘掉 `dsh-purge`、`dsh-purge-cwd-compat` 两个条目（**只删条目，包本体不删**，想回退随时能加回来）。跑完脚本重启即可：

   ```powershell
   node scripts/install.mjs
   ```

2. **手动检查**：打开 `<profile>/package.json`，确认 `dsh.profile.bundles` 里没有同时出现 `dsh-sunder` 和 `dsh-purge`。
3. **想临时共存**：把 `dsh-sunder` 放到 `dsh-purge` **之后**，并保留 `guard: true`（守卫负责补齐被顶掉的段）。共存下撞名的段仍会报错，这种情况只能二选一。
4. **改了 `extraPrompt` 之后报变量错**：不是 `extraPrompt` 的问题——它属于 `sunder:rules` 段，整段 `interpolate: false`，写 `{{…}}` 也只会原样显示。

## 4. 公告源被墙

**症状**：公告一直是随包的那条；`sunder_status` 里 `feed_error=` 有值；或者 `source=bundled`。

**原因**：`raw.githubusercontent.com` 与 `api.github.com` 在某些网络下不可达，镜像也没配上。

**修**（按成本从低到高）：

1. **看现状**：`sunder_status` 会打印主源、实际来源（`feed=` / `source=`）和最后一条错误。
2. **加镜像**：

   ```yaml
   config:
     feedMirrors:
       - https://your-mirror.example/dsh-sunder/announcements.json
   ```

   顺序是：`feedUrl` → `feedMirrors` → 内置镜像（`builtinMirrors: true` 时的 GitHub contents API 与 `ghproxy.net` 反代）→ 随包兜底。任一成功即停止。
3. **换主源**：把 `feedUrl` 直接指到自建地址；插件接受的格式有四种：裸数组、`{ "announcements": [...] }`、JSON 字符串、GitHub contents API 的 base64 响应。
4. **彻底关掉**：`announcements: false`。公告不再拉、不再注入，`sunder_notice` 仍能查询已有的确认记录。

随包兜底只在**所有远端源都失败**时启用（`bundledAnnouncements: true`）。如果 `source=bundled` 且你确认网络正常，检查 `feedUrl` 是否写错、镜像是否返回了非预期的 HTML（插件会把"不是合法 JSON"当成失败并换下一个源）。

想立刻重拉一遍而不等定时器：调用 `sunder_notice` 并传 `action: "refresh"`。它绕过缓存走完整条源链，返回首行 `refreshed`、`unread=`、`source=`，失败时附 `feed_error=`；成功后 `sunder_status` 里的 `feed_error=` 也会恢复 `none`。

## 5. 更新检查 403 与限流

**症状**：`sunder_status` 的更新一栏是 `error`；`sunder_update` 返回 `update check failed: 403 Forbidden` 或 `API rate limit exceeded`。

**原因**：GitHub API 对未认证请求按 IP 限流（每小时几十次，同一出口 IP 共享）。另外代理、公司网关也可能直接返回 403。

**修**：

1. **别急着重试**：失败结果会以 `{ checkedAt, error }` 写进状态文件，默认 6 小时内不再请求。等一小时后自愈。
2. **确认是不是网络**：

   ```powershell
   curl.exe -sS -o NUL -w "%{http_code}`n" https://api.github.com/repos/menghuanshiguang/dsh-sunder/releases/latest
   ```

   403 / 429 就是限流或网关拦截，404 是仓库或 tag 写错。
3. **强制再试一次**：`sunder_update` 会绕过缓存。
4. **换源**：改 `repo` 指向你自己的镜像仓库；或 `updateCheck: false` 完全关掉，需要时手动看 Releases。
5. **改了 `updateIntervalHours` 没反应**：下限是 1 小时（`Math.max(1, …)`），写成 0.1 会按 1 小时算。
6. **`sunder_update action=apply` 失败**（`applyUpdate`）：检查 API 通了、下载却 403，通常是网关只放行 `api.github.com`、拦了源码包域名（`codeload.github.com` 一类）。插件在这种情况下会退到 contents API 逐文件拉取；两条路都失败才报 `{ ok: false, error, url }`，此时看错误里带的 `url` 直接手动下载。已有安装不会被写坏——它是先校验包名再落盘；真要回滚，用工具报告里的 `backup=` 路径覆盖回去再重启。

更新检查失败**不影响插件其他功能**：三段提示词、公告、工具都照常。

## 6. 回滚与卸载

### 用脚本（v1.1.0）

```powershell
node scripts/install.mjs --uninstall   # 摘依赖、摘 bundles 条目、删 node_modules 链接
node scripts/install.mjs --dry-run     # 只看计划
```

脚本改 profile 之前写 `package.json.bak-<时间戳>`，想手工恢复就用那个文件。

### 手动

1. 从 `<profile>/package.json` 的 `dsh.profile.bundles` 删掉 `"dsh-sunder"`；
2. 从 `dependencies` 删掉 `"dsh-sunder"`；
3. 删 `<profile>/node_modules/dsh-sunder`（junction 用 `rmdir`，别用会跟进链接的递归删除）；
4. 重启 DSH。

### 只想临时停用

不用卸载：在 `cordis.patch.yml` 的 `id: sunder` 那一行写 `enabled: false`，重启。插件还在，但什么都不注册。

### 想连"已读/已确认"一起重置

删 `$DSH_HOME\sunder\state.json`（默认 `~/.dsh/sunder/state.json`），下次启动会重新生成。

## 7. 怎么收集诊断信息

先跑内置诊断（只读，不改任何文件）：

```powershell
npm run doctor                      # 或 node scripts/doctor.mjs
node scripts/doctor.mjs --json      # 机器可读
node scripts/doctor.mjs --no-network
node scripts/doctor.mjs --profile <profile 目录> --runtime <DSH 运行时目录>
```

10 项检查：`node`/`profile`/`bundle`/`link`/`manifest`/`composition`/`feed`/`update`/`state`/`version`。退出码 `0` 健康（`warn` 不算失败）、`1` 有 `fail`、`2` 用法错误。输出里每项的 `id` 对应下面各节。

提 issue 前把这些贴进来，基本就能定位：

```powershell
# 1) 环境
node --version
# DSH 版本：DSH 的「关于」面板，或启动日志第一行

# 2) profile 位置与安装状态
echo $env:DSH_HOME                                  # 可能为空 = 默认 ~/.dsh
Get-Content "$HOME\.dsh\profiles\desktop\package.json" | Select-String -Context 0,6 'dsh-sunder|bundles'
Get-Item "$HOME\.dsh\profiles\desktop\node_modules\dsh-sunder" | Select-Object LinkType, Target

# 3) 状态文件（含最近一次公告/更新结果）
Get-Content "$HOME\.dsh\sunder\state.json"

# 4) 插件配置
Get-Content "<profile>\cordis.patch.yml" | Select-String -Context 0,10 'id: sunder'
```

再加两样：

- **会话内的 `sunder_status` 原样输出**（它能一次给出语言、预设、守卫、公告来源、更新结论、段位、状态文件路径）；
- **DSH 启动日志里所有含 `dsh-sunder` 或 `prompt` 的行**（`interpolate`、`already registered`、`unknown prompt variable` 这类错误都在这里）。

提交时用仓库的 [Bug 报告模板](../.github/ISSUE_TEMPLATE/bug_report.yml)，它会要求同样这几项。

## 8. 其它常见问题

| 问题 | 说明 |
| --- | --- |
| `language` 设了 `auto` 但出来是英文 | `auto` 读的是 DSH 进程的 `Intl` 区域设置（`zh*` 才用中文）。显式写 `language: zh` |
| `preset` 设了没变化 | 未知值会回落 `full`。启动日志里搜 `unknown preset`；`sunder_status` 里看 `preset=` |
| `extraPrompt` 没出现 | 它追加在**规则段**末尾，去看看 `sunder:rules` 而不是身份段；空串等于不追加 |
| 工具不见了 | `tools: false`，或者宿主没提供 `ctx.tools` |
| 提示词段在，但感觉没生效 | 先确认宿主身份段真的关了：`cordis.patch.yml` 里 `includeHarnessIdentity: false`；再看 `placements=` |
| 状态文件在别处 | 设置了 `DSH_HOME` 的话，路径是 `$DSH_HOME/sunder/state.json` |
| 想确认 guard 在不在 | `sunder_status` 的 `guard=on`；`guard: false` 时 waterfall 兜底仍会在，但访问器不装 |
| 面板只显示 3 条公告 | 客户端横幅上限固定 3 条，和宿主默认 `announceLimit: 3` 对齐；想多看就把 `announceLimit` 调大，或用 `sunder_notice action=list` |
| 面板里语言/预设显示"未知" | v1.3.0 及更早的 host 没有 HTTP 桥，只能读 `pluginManager`/`pluginInventory`。升级到 1.3.1 并重启后，面板走 `/sunder/api/status`，显示真实值；桥失败时看卡片底部 `host 桥：` 告警 |
| 面板显示 `公告源: HTTP 429` | v1.3.1 前客户端直连 `api.github.com` 触发了未认证限流。升级并重启后客户端不再请求 GitHub；host 侧 feed 走 `api.github.com` 镜像 + 随包兜底，不会 429 |
| 面板顶部提示"未连上 host 桥" | 当前 host 没注册 `/sunder/api/*`：DSH < 1.3.1，或 profile 没有 `webServer`（headless）。面板自动降级为只读静态信息 |
| `doctor` 报 `profile` fail | 传 `--profile <真实 profile 目录>`；v1.3.1 起 `DSH_PROFILE=desktop` 这类 profile **名字**会解析成 `<DSH_HOME>/profiles/desktop`（之前会被当成相对路径），`DSH_HOME` 为空时是 `~/.dsh` |

还搞不定 → 开 issue，附上[第 7 节](#7-怎么收集诊断信息)的材料。设计层面的"为什么这样"看 [ARCHITECTURE](./ARCHITECTURE.md)。
