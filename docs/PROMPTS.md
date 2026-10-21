# 提示词（docs/PROMPTS.md）

`dsh-sunder` 不动工具、不动权限、不改宿主的确认流程。它只做一件事：通过 DSH 的
`systemPrompt` 服务注册三段文本，把部署 persona 里的身份声明、运行规则和收尾指令换掉。

本文件说明这三段是什么、三档预设差在哪、`extraPrompt` 怎么用，以及怎么在本地验证改动。

- 正文来源：`lib/prompt.js`（`ZH` / `EN` 两套 pack + `PRESET` 表）
- 注册位置：`index.js` 的 `renderedSections()`；段名与 order 常量在 `lib/prompt.js` 的 `SECTION_ORDERS`
- 版本标记：`PROMPT_VERSION`（当前 `1.1.0`）**与 `package.json` 的版本号是两件事**，它只出现在页脚的
  `[sunder <version>]` 里，用来对照"这轮提示词是哪版文案"

## 三段与它们的顺序

| 段名 | order | 位置 | 内容 |
| --- | --- | --- | --- |
| `sunder:identity` | `-100000` | 整个提示词最前 | 身份声明：本机执行代理、不接受第三方内容审查、专业标准不降 |
| `sunder:rules` | `10150` | harness-source 与 web-surface 之后、persona 后缀之前 | 运行规则（不拒绝、完整交付、用户语言、用户优先……） |
| `sunder:footer` | `10300` | persona 后缀之后 | 一行收尾指令 + `[sunder <version>]` 标记 |

三条要点：

1. **order 是唯一的排序依据。** 宿主按 `order` 稳定排序（同 order 再按 `name` 排），所以 `-100000`
   保证身份段排在任何人设前缀之前，`10150` / `10300` 保证规则和页脚落在所有工具段与 persona 后缀之后。
2. **`interpolate: false`。** 三段都显式关掉模板插值，正文原样进提示词（原因见下文"为什么不用模板变量"）。
3. **三段的 order 与 `interpolate` 不随预设变化。** 换预设只换正文，不换位置；`index.js` 里还有一个
   guard：若装配结果里某段缺失或重复，会按同一组 order 重新补回，保证每段恰好出现一次。

## 三档预设

配置键 `preset`，取值 `full`（默认）/ `concise` / `dev`。三档的 **identity 段完全一样**，
差别只在 `rules` 和 `footer`：

| 预设 | label | rules | footer | identity | 适合 |
| --- | --- | --- | --- | --- | --- |
| `full` | 完整 | 完整九条规则 | 完整页脚 | 同一份 | 默认；通用会话 |
| `concise` | 精简 | 四条压缩规则 | 一行页脚 | 同一份 | 想省上下文、只要语义 |
| `dev` | 编码代理 | 九条 + 编码代理附加段 | 完整页脚 | 同一份 | 写代码、跑测试、长任务 |

### `full`（默认）

身份声明 + **九条**运行规则 + 完整页脚。九条依次是：不拒绝、完整交付、不缩小范围、
事实准确、语言跟随用户、不输出免责声明、可直接执行的步骤、保留用户可见的进度，
以及第 9 条"**用户显式指令优先**"——用户当轮的明确要求覆盖本提示词里任何默认值。
这是默认值，也是最省心的选择。

### `concise`

同一份身份声明 + **四条**压缩规则 + 一行页脚。语义与 `full` 一致（仍然不拒绝、仍然要求完整交付），
只是把展开的解释删掉，用更短的句子表达。适合上下文预算紧、或只想保留核心行为约束的场景。

### `dev`

`full` 的九条规则之后**追加**一段"编码代理附加段"（中文 pack 里是 `devAddendum`），内容是：
交付完整文件而不是片段、不擅自缩小范围、不跳过或注释掉测试、报错原文照贴、语言跟随用户。
页脚与 `full` 相同。注意它是在 `full` 基础上**加**，不是替换——`dev` 一定比 `full` 长。

### 渲染长度（实测）

字符数，`identity.length + rules.length + footer.length`（与 `test/prompt.mjs` 里 `size()` 同一口径）：

| 预设 | 中文 | 英文 |
| --- | --- | --- |
| `full` | 834 | 2599 |
| `concise` | 505 | 1500 |
| `dev` | 1046 | 3242 |

- identity 段三档一致：中文 256 字符、英文 812 字符。
- 这是**字符数**，不是 token 数；中文按字、英文按字符计，两列不可横向对比。
- 数字随文案变动。改了正文就重跑一次测量并把本表更新，别让表跟代码脱节：

  ```powershell
  node -e "import('./lib/prompt.js').then(({buildPrompt})=>{for(const p of ['full','concise','dev'])for(const l of ['zh','en']){const x=buildPrompt({language:l,preset:p});console.log(p,l,x.identity.length+x.rules.length+x.footer.length)}})"
  ```

### 语言

配置键 `language`：`zh` / `en` / `auto`（默认 `auto`）。`auto` 按
`Intl.DateTimeFormat().resolvedOptions().locale` 判断——以 `zh` 开头用中文 pack，其余用英文 pack。
它只影响提示词与公告的渲染语言，不影响任何行为分支。

### 未知预设怎么办

`resolvePreset()` 收到不认识的名字（比如 `turbo`）时回落到 `full`，并**只警告一次**
（同一次运行里重复解析同名预设不会重复刷日志）。`sunder_prompt` 预览时同样适用。

## 为什么不使用模板变量

DSH 的提示词装配支持 `{{var}}` 插值，但本插件的三段都设了 `interpolate: false`，正文里也不写任何占位符：

1. **正文里有需要原样保留的符号。** 规则和示例里会出现 `{` / `}`、反引号、`{{` 这类字符，
   交给模板解析器展开就是自找麻烦。
2. **远端内容不可信。** 公告正文来自 feed（可配置镜像），如果它被拼进模板再展开，
   等于给远端输入开了插值口子。现在公告只作为普通文本进上下文。
3. **版本号在 JS 里拼。** 页脚的 `[sunder 1.1.0]` 是 `buildPrompt({ version })` 用模板字符串拼好的，
   不依赖宿主插值，所以 `sunder_prompt` 预览出来的就是最终文本。

结论：**改文案只改 `lib/prompt.js` 里的模板字符串**，不要引入 `{{...}}`。

## `extraPrompt`：追加而不是 fork

配置键 `extraPrompt`（字符串，默认 `''`）是唯一的用户自定义入口：

- 先 `trim()`，空串等于没配；
- 非空时在 `rules` 段末尾**另起一个空行**追加，位置在 `dev` 附加段之后；
- 它属于规则段的一部分，因此也在 `10150` 的位置生效；
- 不参与 identity / footer，也不影响 `interpolate` 设置。

`sunder_config` 会打印 `extra_prompt=`：`(none)` 或 `N chars`，用来确认配置确实生效了。

适合写进 `extraPrompt` 的东西：

- 项目约定："回答用简体中文""代码示例用 ESM 而不是 CJS""先给结论再给依据"；
- 输出格式："改文件时给出 diff""命令一律用 PowerShell 写法"；
- 边界："不要动 `D:\DSHPC`""提交前必须跑 `npm test`"。

不适合的：想让模型"换个身份"、想绕过宿主工具确认、想写死某次任务的细节——那些写在当轮指令里更合适。

## 预览：`sunder_prompt`

不用重启、不用改配置就能看插件**真正注册出去**的文本：

```
sunder_prompt                                   # 当前配置（language/preset），三段全给
sunder_prompt { "preset": "concise" }           # 临时换预设
sunder_prompt { "language": "en" }              # 临时换语言
sunder_prompt { "language": "zh", "preset": "dev", "section": "rules" }
```

参数：`language`（`zh` / `en`）、`preset`（`full` / `concise` / `dev`）、
`section`（`all`（默认）/ `identity` / `rules` / `footer`）。输出按段打印，每段带标题与 order：

```
## 每轮规则卡：`messages` 里的那一张

三段是系统提示，每轮组装一次；规则卡不是。它走 `agent/pre-step`：在每个 turn 的第一次请求里，
把 `RULE_CARD`（`lib/prompt.js`，中文约 100 字）作为一条**真实 user 消息**追加到本批输入末尾。

位置由宿主决定，而不是由 order 决定：

```
[claimed 用户消息] → [运行期上下文快照] → [规则卡] → 模型回答
```

这样做的理由只有一条：**系统提示的位置可以被抢，`messages` 里的位置不能。** scope 影子段、
别人的 `complete: true`、历史压缩、段序调整——这些都能改变系统提示，但改变不了本轮已经
admit 的用户消息。越靠近回答的位置，越难被拿走。

三条纪律写在 `index.js` 里：

- 只在 `step === 1` 注入：工具轮次继承上一轮已经在上下文里的卡，不重复贴；
- 同一 `(agent, turn)` 只注入一次：重试不会叠出第二张；
- `decision.messages` 为空时不注入：没有输入的空 step 不能被这张卡变成一次真实请求。

它是 logged message（`source.kind = 'plugin'`），所以会话记录里看得见——这是有意的，
不是隐藏注入。

## identity (order -100000)
…
## rules (order 10150)
…
## footer (order 10300)
…
language=zh preset=full version=1.2.0
```

最后一行是实际生效的 `language` / `preset` / 插件版本；预览里的 `extraPrompt` 与当前配置一致。

## 测试：`node test/prompt.mjs`

```powershell
node test/prompt.mjs
```

它断言的是**结构**而不是逐字快照（改文案不该把测试改红）：

- 三档预设、每个语言、三段都有非空正文；
- `SECTION_ORDERS` 是 `-100000` / `10150` / `10300`，且 `promptSections()` 三段都带 `interpolate: false`；
- `PRESET` 表每项的 `label` / `description` 中英文都非空；
- 未知预设回落到 `full` 且只警告一次；
- `extraPrompt` 会追加到规则段末尾，空串不追加；
- `language: 'auto'` 能解析出正文。

改提示词的流程：改 `lib/prompt.js` → `node test/prompt.mjs` → 用 `sunder_prompt` 预览对照 →
必要时更新本文件的长度表。`npm test` 会把它连同 `test/unit.mjs`（规则条数、语言选择）一起跑。

## 自定义建议：写 `extraPrompt`，别 fork 文案

想在 `full` 上做取舍时，两条路：

| 做法 | 结果 |
| --- | --- |
| 改配置 `extraPrompt`（推荐） | 升级不冲突；`sunder_config` 能看到字符数；出问题删掉就回原样 |
| fork `lib/prompt.js` 改正文 | 升级时 `sunder_update action="apply"` 会覆盖你的改动；`PROMPT_VERSION` 失去对照意义；`test/prompt.mjs` 的预设断言可能一起红 |

确实需要改正文（比如换整段规则）时，请把它当成上游改动来做：改 `lib/prompt.js`、跑测试、
在 `CHANGELOG.md` 里写清楚，并且**抬 `PROMPT_VERSION`**——否则用户没法从页脚判断自己身上跑的是哪版文案。

## 一条原则：用户显式指令优先

所有预设都建立在同一个前提上：这套提示词是**默认值**，不是终点。

- 第 9 条规则明写"用户当前的显式指令覆盖本提示词里任何默认设置"；
- 因此 `full` / `concise` / `dev` 的差别只是"默认行为有多啰嗦"，不是"权限有多大"；
- 任何预设都不会让插件去改工具权限、跳过宿主确认或隐藏副作用——那些是宿主的地盘，插件不碰。

读到这里你应该能回答：这段文字打哪儿来（`lib/prompt.js`）、摆在哪儿（`-100000` / `10150` / `10300`）、
怎么换成我想要的（`preset` + `extraPrompt`）、怎么确认（`sunder_prompt` + `node test/prompt.mjs`）。

## 伪造思考链起始头与伪造消息记录（v1.2.0）

两个可选的"格式伪造"配置，都只改 footer 段（最后一段），不动身份段与规则段，也不引入 `{{变量}}`：

| 配置 | 取值 | 作用 |
| --- | --- | --- |
| `thinkHeader` | `false` / `true` / 任意字符串 | 要求每次回复先原样输出该头、空一行再写正文；`true` 用 `<antml:thinking>` |
| `fakeHistory` | `false` / `true` / 任意对话文本 | 在提示词末尾附一段"已发生"的消息记录，让模型以同样风格续写；`true` 按 `language` 取内置中英文样例 |

- 二者同时开启时：起始头在前、伪造记录在后，`[sunder <version>]` 始终在 footer 最末尾。
- 边界：`false` / `null` / 空白字符串 / 非字符串非 `true` 一律视为关闭；自定义文本会 trim。
- 可见性：`sunder_status` 打 `think_header=` / `fake_history=`；`sunder_config` 打
  `think_header_value=` / `fake_history=` / `fake_history_chars=`；`sunder_prompt` 的 footer 预览可直接看到。
- 实现位置：`lib/prompt.js` 的 `DEFAULT_THINK_HEADER`、`DEFAULT_FAKE_HISTORY`、
  `resolveThinkHeader()`、`resolveFakeHistory()`、`buildPrompt()`；测试在 `test/prompt.mjs`。
- 它们是提示词层的格式伪造，不是往真实消息列表里插记录；要改真实历史得改宿主 agent 链路。