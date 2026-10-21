# 架构说明

这份文档解释 dsh-sunder 在 DSH 里**怎么挂上去、怎么活下来、怎么失败**。它是给改代码和排查问题的人看的；只想用插件的话读 [README](../README.md) 就够了。

## 一张图

```
                 ┌──────────────────────── DSH profile ────────────────────────┐
package.json ───►│ dsh.profile.bundles = [dsh-base, dsh-web-app, …, dsh-sunder] │
                 │                          │                                  │
                 │            按顺序叠层     ▼                                  │
                 │  dsh-sunder/cordis.patch.yml  ──┬─ patch(system-prompt)       │
                 │                                └─ insert(id=sunder)           │
                 └────────────────────────┬───────────────────────────────────┘
                                          │ profile 启动时实例化
                                          ▼
                              index.js  apply(ctx, config)
                                 │  ├─ systemPrompt.section × 3   （interpolate:false）
                                 │  ├─ ctx.systemPrompt.context × 2（公告、更新提醒）
                                 │  ├─ ctx.tools.register × 3~5
                                 │  ├─ assemble guard（Symbol.for 访问器）
                                 │  └─ setInterval：公告/更新巡检
                                 ▼
   每次模型请求 → systemPrompt.assemble(context) → 排序/渲染 → 模型
                        ▲
                        └─ guard 在这里补齐缺失的 sunder:* 段
```

## 1. bundle patch 与 profile 组装

`package.json` 里 `dsh.bundle.patch` 指向 `./cordis.patch.yml`，profile 组装时把它当作一层 patch 生效：

```yaml
# 1) 关掉宿主身份段，让用户的身份声明排在它前面
- id: system-prompt
  config:
    includeHarnessIdentity: false

# 2) 把插件本身插进树里
- insert:
    - id: sunder
      name: dsh-sunder
      inject: [systemPrompt]
      config:
        enabled: true
        language: auto                 # auto | zh | en
        preset: full                   # full | concise | dev（v1.1.0）
        extraPrompt: ""
        announcements: true
        announceLimit: 3
        feedUrl: https://raw.githubusercontent.com/menghuanshiguang/dsh-sunder/main/announcements.json
        feedMirrors: []
        builtinMirrors: true
        bundledAnnouncements: true
        updateCheck: true
        updateIntervalHours: 6
        repo: menghuanshiguang/dsh-sunder
        tools: true
        guard: true
        debug: false
```

三个要点：

- **`inject: [systemPrompt]`** 让插件在 `systemPrompt` 服务就绪后才执行 `apply`；服务名也是插件访问宿主的唯一入口。
- **patch 是整行替换**：同一个 `id` 的 `config` 不做深合并。profile 里再写一个 `id: sunder` 的 patch，会把上面这份 `config` 整体顶掉；相对地，patch 里没写的键会回落到 `index.js` 的 `DEFAULTS`（两边同名同值，patch 里列出来只是为了让配置一眼可见）。
- **`bundles` 顺序即叠层顺序**：`dsh-sunder` 必须在最后，它的 patch 才有机会覆盖前面的 `system-prompt` 行。

`includeHarnessIdentity: false` 不是可选项：宿主身份段（order `-1000`）如果还在，会和 `sunder:identity`（order `-100000`）说两套话，模型看到的是先"你的唯一身份是 X"再"你不代表任何平台"。关掉它，第一段就只剩用户的选择。

## 2. 三段提示词的位置

| 段名 | order | 为什么在这里 |
| --- | --- | --- |
| `sunder:identity` | `-100000` | 整份提示的第一段。宿主身份段是 `-1000`，任何"更靠前"的抢占都必须在这里发生 |
| `sunder:rules` | `9600` | 所有工具段（`1000`–`5000`）之后、`STRUCTURED_OUTPUT`（`9900`）与 `HARNESS_SOURCE`（`10000`）之前。规则夹在中段工具清单之后，才不会被 schema 噪声淹没 |
| `sunder:footer` | `10300` | 最后一段。`DEPLOYMENT_PERSONA_SUFFIX`（`10200`）之后，模型读到的最后一句仍是"用户指令是唯一权威" |

order 被冻结在 `lib/prompt.js` 的 `SECTION_ORDERS` 里，测试（`test/prompt.mjs`）直接断言这三个数字。预设（`full` / `concise` / `dev`）只改文案，不改位置。

### 为什么不用模板变量

DSH 的插值是严格的：段文本里出现未注册的 `{{var}}`，渲染时**直接抛错**，那一轮的系统提示就没了。Sunder 的三段全部 `interpolate: false`，文案里一个 `{{` 都没有——不是"记得别写变量"，而是整段根本不走插值。这条约束写进了 `test/prompt.mjs`（断言 `text` 不含 `{{`），也写在 `lib/prompt.js` 的头注释里。

### 运行期上下文

| 名称 | order | 出现条件 |
| --- | --- | --- |
| `sunder:update` | `3400` | `updateCheck` 发现新版本且没有错误；内容是版本号 + Release 链接 |
| `sunder:announcements` | `3600` | 有未确认公告；`text` 是函数，每次 assemble 现算，空串会被宿主丢弃 |

上下文和段落不同：段落在系统提示里，上下文走另一条通道，`text` 还可以是函数（每次 assemble 现算）。返回值是空串时宿主不会把它带上。

## 3. assemble guard 的生命周期

### 它要解决什么

`systemPrompt.assemble()` 的结果是宿主自己拼的：任何注册了 `complete: true` 段的插件都能让 `sections` 只剩它自己那一段；别的插件也可能在 waterfall 里重建整个 assembly。Sunder 的目标是"无论谁怎么拼，三个 `sunder:*` 段都在"。

### 安装路径

`installGuard()` 每次执行都做同一件事：拿到当前的 `ctx.systemPrompt`，在它的 `assemble` 上加一层包装。三条硬约束决定了它长这样：

1. **不能在 proxy 上存属性。** cordis 每次读 `ctx.systemPrompt` 都返回新的 proxy，普通属性存不住。
2. **不能用普通 Symbol 去重。** 插件可能被加载两次（不同 scope），模块级变量不共享。
3. **不能反复套壳。** 每次 `installGuard()` 都包一层的话，十次调用之后一次 assemble 要递归十层。

所以：

```js
const GUARD = Symbol.for('dsh-sunder.assembleGuard'); // 进程级共享键
```

`Symbol.for` 是全局注册表，任何模块实例拿到的都是同一个键，于是"这个服务上是否已经有守卫"可以跨 scope 判断。

### 复用顺序（三级）

```
1. Object.getOwnPropertyDescriptor(service, 'assemble').get[GUARD]   // 宿主用 getter 装 assemble
2. service[GUARD]                                                    // 我们自己的 getter 已就绪
3. original._sunderWrapped                                          // 已是我们的包装函数
   └─ 命中任一级 → attach(已有 slot)，不重新 wrap
```

`slot` 里装着 `{ sections, install }`：`sections` 是三段的一个固定快照（每次 assemble 用同一份数组），`install` 只是记录。复用 slot 而不是重新包，保证多次 `installGuard()` 之后组装链长度恒为 1。

### 包装函数

```js
const bound = fn.bind(promptService);
async function assembleWithSunder(...args) {
  let assembled;
  try {
    assembled = await bound(...args);
  } catch (error) {
    if (config.debug) console.warn(...);          // 内层失败只记日志
    return { sections: [], contexts: [], tools: [] }; // 不把异常抛回宿主
  }
  try {
    return ensureSunderSections(assembled, slot.sections);
  } catch {
    return assembled;                              // 补段失败不拖垮整轮
  }
}
```

`ensureSunderSections` 是纯函数：assembly 不是对象、没有 `sections` 数组就原样返回；否则按 `name` 去重补齐缺的段，再按 `(order ?? 0, name)` 排序。

### getter 与 setter

包装完成后，`assemble` 被换成带 getter/setter 的访问器：

- **getter** 返回当前的包装函数，并顺手把 `slot` 挂在函数上（`[GUARD] = slot`）；
- **setter** 在宿主重新赋值时用 `wrap(next)` 重新包一层，并把新函数存为 `current`。

这样即使宿主在后来的某个时刻替换了 `assemble`（或者自己用 `defineProperty` 装了个 getter），下一次读到的仍然是带守卫的版本。

### 兜底：waterfall 与定时器

访问器只能保护"从服务对象上读 `assemble`"这条路径。真正的保险是第二条路：

```js
ctx.on('system-prompt/assemble', async (...args) => { … }, {
  global: true,   // 不受 scope 限制
  prepend: true,  // 排在最前，看到的是宿主原始结果
});
```

监听器拿到 assembly 后调用 `next()`（末参是函数时），最后同样走一遍 `ensureSunderSections`。**`guard: false` 只关掉访问器，这条 waterfall 仍然在**——所以 `guard: false` 不是"禁用 Sunder 段"，只是换一种更保守的方式参与。

再加两道保险：

- `ctx.on('session/created', …)` 每次新建会话重装一次；
- `setInterval(installGuard, 4000)`（`unref`）兜住"宿主绕开 setter 直接改 descriptor"的极端情况。

### 为什么 dispose 是 noop

`installGuard()` 不注册自己的 `ctx.effect`。原因写在 `index.js` 的注释里：cordis 的 effect cleanup 不只在插件销毁时触发，也会在 **scope 结束、会话边界、preset 切换** 时触发。如果把"解绑 assemble"写成 cleanup，守卫就会在会话中途被拆掉，之后所有请求都回到没有 Sunder 的状态——而且是静默的。

真正需要清理的只有两样，它们各自有 owner：

| 资源 | 清理方式 |
| --- | --- |
| 4 秒定时器 | `ctx.effect(() => () => clearInterval(timer))` |
| 500ms 防抖的 state 写入 | 同一个 cleanup 里 `flush()` 落盘 |

也就是说：**"解绑守卫"不是一次事件，插件活多久守卫就该在多久**。真正失效的场景只有插件本身被卸载或 DSH 退出。

## 4. 状态文件

路径：`$DSH_HOME/sunder/state.json`（`DSH_HOME` 优先，未设置时 `~/.dsh`）。`resolveDshHome()` 在 `lib/state.js`。

```json
{
  "schema": 1,
  "installId": "3f2c…",
  "firstRunAt": "2026-10-21T12:00:00.000Z",
  "lastUpdateCheck": {
    "checkedAt": "2026-10-21T12:05:00.000Z",
    "latest": "1.0.1",
    "url": "https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.0.1",
    "publishedAt": "2026-10-21T09:30:00.000Z",
    "newer": false
  },
  "seenAnnouncements": { "2026-10-21-hello-sunder": "2026-10-21T12:00:01.000Z" },
  "ackedAnnouncements": [],
  "lastAnnouncementCheck": "2026-10-21T12:00:01.000Z"
}
```

| 字段 | 写入者 | 读取者 |
| --- | --- | --- |
| `schema` | `emptyState()` / `loadState()` 归一 | `loadState()` |
| `installId` / `firstRunAt` | 首次 `emptyState()` | 目前只做记录 |
| `lastUpdateCheck` | `checkForUpdate()` | `sunder_status`、缓存判断 |
| `seenAnnouncements` | `markSeen()`（每条被选中的公告） | 目前只做记录 |
| `ackedAnnouncements` | `sunder_notice ack` / `ack-all` | `selectAnnouncements()` 打 `acknowledged` 标记 |
| `lastAnnouncementCheck` | 一次成功的公告刷新之后 | `sunder_status` |

写入是"同目录临时文件 + `renameSync`"：先 `mkdirSync(dir, { recursive: true })`，写到 `state.json.<pid>.tmp`，再原子替换。**任何失败都返回 `false`，不抛异常**——状态写不进去只该丢"已读记录"，不该影响这一轮对话。`index.js` 在上层做 500ms 防抖，避免每轮 assemble 都碰磁盘。

## 5. 公告与更新的镜像链

```
fetchAnnouncements
  ├─ feedUrlList = [DEFAULT_FEED, ...config.feedMirrors, ...(builtinMirrors ? DEFAULT_FEED_MIRRORS : [])]
  │                （去重，保持顺序）
  ├─ 逐个 fetchJson，成功即 decodeFeedPayload
  │     ├─ 裸数组
  │     ├─ { announcements: [...] }
  │     ├─ JSON 字符串
  │     └─ GitHub contents API 的 { encoding: "base64", content: "…" }
  ├─ normalize：id/title/body 必需，level 非法降级 info，保留 date/link/minVersion/maxVersion
  ├─ select：版本区间过滤 → acknowledged 标记 → 日期倒序（同日期 critical > warn > info）→ 取前 limit 条
  └─ 全部失败 → { ok: false, error: 最后一条错误 }
```

`index.js` 在 `ok: true` 时更新 `runtime.unread`、`feedSource` 并清零 `feedError`；`ok: false` 时记录 `feedError`，然后（若 `bundledAnnouncements` 为真）用随包的 `announcements.json` 再选一次，来源标为 `bundled`。

更新检查是另一条独立的链：

```
checkForUpdate
  ├─ 缓存命中（checkedAt 可解析且 < intervalHours 小时）→ { …, fromCache: true }
  ├─ GET api.github.com/repos/<repo>/releases/latest
  │     失败 → GET …/tags，取第一个 tag（只能给链接，判断不了是否更新）
  ├─ isNewer(latest, currentVersion) → newer
  └─ 写 state.lastUpdateCheck（成功：完整记录；失败：{ checkedAt, error }）
```

两条链都在插件启动时立刻跑一次，之后每 `max(1, updateIntervalHours) * 3600_000` 毫秒跑一次（定时器 `unref`，不阻止进程退出）。

### 应用更新（v1.1.0）

`checkForUpdate` 只回答"有没有新版本"。真正动手的是 `lib/update.js` 的 `applyUpdate({ dir, ... })`，它被 v1.1.0 的设置面板调用：

```
applyUpdate
  ├─ 读安装目录的 package.json；name 存在但不是 dsh-sunder → not-a-sunder-install（不写）
  ├─ 解析 latest：GitHub 令牌优先取 `gh auth token`，其次 GH_TOKEN / GITHUB_TOKEN
  ├─ 不新（且未 force）→ { ok: true, method: 'up-to-date' }，一个文件都不改
  ├─ 下载源码包（zip / tar）→ 解压到 os.tmpdir() 下的临时目录
  │     下载或解压失败 → 退到 GitHub contents API 逐文件拉取
  ├─ 关键安全闸门：解压结果里的 package.json.name 必须是 dsh-sunder 才允许写入
  └─ 写入安装目录 → { ok: true, previous, version, method, files }
```

失败返回 `{ ok: false, error, url?, detail? }`，**永不抛异常**；因为先校验包名再写盘，下到半截文件或错误内容时现有安装不会被污染。安装目录写在 profile 的 `node_modules/dsh-sunder`（junction / 复制目录），所以更新之后仍需重启 DSH。

## 6. 失败模式

| 场景 | 代码行为 | 用户能感知到的后果 |
| --- | --- | --- |
| 宿主 `assemble` 抛错 | guard 捕获，返回 `{ sections: [], contexts: [], tools: [] }` | 这一轮没有系统提示；`debug: true` 时有警告日志 |
| 补段过程抛错 | 原样返回宿主的 assembly | Sunder 段缺失，其余照常 |
| 别的插件注册 `complete` 段 | 宿主只返回那一段 | guard 把三段补回去 |
| 同名段已被注册 | 宿主注册时抛 `prompt section "…" is already registered` | 启动失败，需要改掉冲突的段名 |
| 别的插件引用了未注册变量 | 宿主渲染时抛错，**整轮**提示失败 | 见 [TROUBLESHOOTING](./TROUBLESHOOTING.md#3-unknown-prompt-variable-与-dsh-purge-冲突) |
| `state.json` 写不进去 | `saveState()` 返回 `false`，不抛 | 已读/确认/缓存不持久，下次重来 |
| 所有 feed 源都失败 | `ok: false` + `feedError` | 看随包兜底公告，或 `sunder_status` 里显示错误 |
| GitHub API 403 / 限流 | 写入 `{ checkedAt, error }`，6 小时内不再请求 | `sunder_status` 显示错误；`sunder_update` 可强制重试 |
| `applyUpdate` 下载/解压失败 | 退到 contents API 逐文件拉取，仍失败则返回 `{ ok:false, error, url }` | 面板报错，现有安装原样保留 |
| `applyUpdate` 目标目录是别的包 | `not-a-sunder-install` / `invalid-install`，不写盘 | 同上 |
| `preset` 拼错 | `resolvePreset()` 回落 `full`，每个未知名字警告一次 | 仍是完整规则，日志里有一行 warning |
| `enabled: false` | `apply` 提前返回，不注册任何东西 | 插件在，但完全没效果（这是开关，不是故障） |

## 7. 模块地图

| 文件 | 职责 | 主要导出 |
| --- | --- | --- |
| `index.js` | 插件入口：读配置、建段、装守卫、注册工具、定时器、状态持久化 | `name`、`inject`、`apply`、`VERSION` |
| `lib/prompt.js` | 文案与预设 | `PROMPT_VERSION`、`SECTION_ORDERS`、`PRESET_NAMES`、`PRESET`、`resolvePreset()`、`buildPrompt()`、`promptSections()` |
| `lib/announcements.js` | feed 解码、镜像链、筛选与渲染 | `DEFAULT_FEED`、`DEFAULT_FEED_MIRRORS`、`fetchAnnouncements()`、`selectAnnouncements()`、`renderAnnouncements()` |
| `lib/update.js` | Releases 查询、缓存、自更新 | `DEFAULT_REPO`、`fetchLatestRelease()`、`checkForUpdate()`、`applyUpdate()`、`isCacheFresh()` |
| `lib/state.js` | 状态路径与原子写入 | `statePath()`、`loadState()`、`saveState()`、`markSeen()`、`ackAnnouncement()` |
| `lib/version.js` | 版本解析、比较、区间 | `compareVersions()`、`isNewer()`、`inRange()`、`isVersion()` |
| `lib/net.js` | 统一 HTTP：超时、UA、错误归一 | `fetchJson()`、`validHours()` |
| `announcements.json` | 随包兜底 feed | —— |
| `cordis.patch.yml` | bundle patch | —— |
| `locale/*.json` | 客户端面板文案（v1.1.0） | —— |
| `scripts/install.mjs` | 安装 / 卸载（v1.1.0） | `install()`、`uninstall()`（`scripts/uninstall.mjs`）、`parseArgs()` |
| `scripts/release.mjs` | 发版：bump、CHANGELOG、tag、Release | —— |
| `scripts/check-package.mjs` | 打包契约检查 | —— |
| `test/*.mjs` | 单元、提示词、冒烟、安装、更新、客户端 | —— |

## 相关文档

- [README](../README.md)：安装、配置表、工具用法
- [TROUBLESHOOTING](./TROUBLESHOOTING.md)：常见症状与诊断
- [CHANGELOG](../CHANGELOG.md)：版本变化
