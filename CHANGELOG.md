# Changelog

All notable changes to **dsh-sunder** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-21

### Added

- 三档提示词预设（配置键 `preset`）：`full`（默认：身份声明 + 九条规则 + 完整页脚）、
  `concise`（同一身份声明 + 四条压缩规则 + 一行页脚，文本长度约为 `full` 的 60%）、
  `dev`（`full` 的九条规则之后再追加"编码代理附加段"）。`lib/prompt.js` 导出
  `PRESET_NAMES`、`DEFAULT_PRESET`、`PRESET`、`resolvePreset`、`buildPrompt({ language, preset, extraPrompt, version })`
  与 `promptSections()`；未知预设回落到 `full`，同一个未知名字只警告一次；三段的
  order（`-100000` / `9600` / `10300`）与 `interpolate: false` 不随预设改变。
- `sunder_config` 工具：一次打印生效配置——语言（含原始值）、预设、公告开关与条数、
  feed 与镜像、内置镜像开关、更新周期、`repo`、`tools` / `guard` / `debug`、
  `extraPrompt` 字符数，以及状态文件路径。
- `sunder_prompt` 工具：预览插件真正注册出去的提示词文本，可用 `language`
  （`zh` / `en`）、`preset`（`full` / `concise` / `dev`）临时覆盖，并用 `section`
  （`all` / `identity` / `rules` / `footer`）只取其中一段。
- `sunder_update` 新增 `action: "apply"`，基于 `lib/update.js` 的新导出
  `applyUpdate()`：解析 latest release → 下载源码包（zip / tar.gz）→ 失败则退到 GitHub
  contents API 逐文件拉取 → **解压结果里 `package.json.name === "dsh-sunder"` 之后**
  才写入安装目录。写盘前把当前安装快照到 `$DSH_HOME/sunder/backups/<时间戳>-v<版本>`，
  报告 `applied` / `from` / `to` / `target` / `method` / `files` / `backup` / `restart` /
  `note`；已经是最新时 `method=up-to-date` 且不动任何文件，没写成时快照会被清掉；
  任何失败都返回 `{ ok: false, error }` 并把错误码翻成中英文说明，从不把异常抛给宿主。
  `action: "apply"` 是显式动作，**不受 `updateCheck: false` 影响**（该开关只关掉后台/检查请求）。
- 浏览器端 `lib/client.js`（`package.json` 的 `dsh.client.platform = "web"`）：设置页
  `Sunder` 分区（`settings.section`，id `sunder`，order 60）显示 bundle 版本、启用状态与挂载阶段、
  语言 / 预设 / guard、未读公告数、最近一次更新检查、最新版本、仓库与 Release 链接；
  右下角公告横幅（`shell.overlay`，id `sunder-notice`）显示最新一条未读公告、未读总数与链接，
  可一键关闭。已读 id、关闭记录与缓存都写在浏览器 `localStorage`
  （`dsh-sunder.acked` / `dsh-sunder.dismissed` / `dsh-sunder.cache`；公告缓存 30 分钟，
  版本检查 6 小时）。客户端是**只读**的：拿不到 host 端配置，也不改写任何插件状态。
- `scripts/install.mjs` / `scripts/uninstall.mjs`：把本仓库挂进一个 DSH profile——在
  `<profile>/node_modules/dsh-sunder` 建 junction（无链接权限时退化为复制）、把
  `"dsh-sunder": "link:<仓库路径>"` 写进 `dependencies`、把 `dsh-sunder` 追加到
  `dsh.profile.bundles`（只从列表里摘掉 `dsh-purge` / `dsh-purge-cwd-compat` 条目，包本体保留）。
  幂等、改 `package.json` 前留 `package.json.bak-<时间戳>`，支持 `-p` / `--profile`、
  `--repo`、`-n` / `--dry-run`、`-u` / `--uninstall`、`-h` / `--help`；卸载是同一套逻辑的反向操作
  （junction 只解链，不跟进删除；目标目录属于别的包时拒绝动它）。
- 离线测试：`test/install.mjs`（tmpdir 里的假 profile 跑完整安装/卸载/回滚）、
  `test/update.mjs`（`applyUpdate` 的源码包、contents API 兜底、包名不符、已是最新等路径）、
  `test/client.mjs`（客户端注册与状态序列化契约）；`test/prompt.mjs` 增补预设覆盖。
- 文档与仓库模板：`docs/ARCHITECTURE.md`、`docs/TROUBLESHOOTING.md`、`.github` 的 issue / PR 模板，
  以及 `locale/{zh,en}.json` 里的 `presets` 文案（label + description）。

### Changed

- 配置键新增 `preset`、`feedUrl`、`feedMirrors`、`builtinMirrors`、`bundledAnnouncements`、
  `repo`；`cordis.patch.yml` 与 `index.js` 的 `DEFAULTS` 保持一致，没写的键用插件默认值。
- `sunder_status` 增加 `preset=`（打印配置里的原值），并把 `feed` / `feed_error` / `update`
  一起列出；启动日志同样带上 `preset=`。
- `sunder_update` 从"只能检查"变成 `action: "check" | "apply"`：`check`（默认）仍然绕过缓存，
  输出 `installed` / `latest` / `upgrade` / `url` / `notes` / `checked_at`；工具描述同步改写。
- 默认预设 `full` 的规则段从 8 条扩到 9 条，新增第 9 条"用户优先"（用户明确指令覆盖所有
  提示层的默认值）；`PROMPT_VERSION` 升到 `1.1.0`。
- `package.json`：版本 `1.1.0`、`test` 脚本覆盖 unit / prompt / client / install / update /
  smoke / check-package，新增 `test:client`、`install:profile`、`uninstall:profile`、
  `release`、`publish:api`、`changelog` 脚本；描述补上预设与自更新，`keywords` 增加
  `self-update`；`dsh.client` 声明 `platform: "web"`。
- CI 增跑 `test/install.mjs`、`test/update.mjs`、`test/client.mjs` 与
  `scripts/check-package.mjs`（Node 20 / 22，`windows-latest`）。
- 随包的 `announcements.json` 增加 1.1.0 条目；README 补齐预设表、新工具、安装脚本、
  客户端 UI 与更新链路。

### Security

- `applyUpdate()` 只往插件自己的安装目录写，并且在解压结果的 `package.json`
  里读到 `name === "dsh-sunder"` 之后才落盘；已是最新、下载失败、包名不符都不会改写现有安装。
- `scripts/install.mjs` / `uninstall.mjs` 会先校验目标 `package.json` 的字段类型，非对象就整体
  放弃；`node_modules/dsh-sunder` 若属于另一个包（不是链接到本仓库、也不是同名副本）则拒绝覆盖。
- 用 `link:`（或安装脚本的 junction）挂载时，安装目录就是仓库工作区，`sunder_update
  action=apply` 会直接改写这份 checkout——它仍然先做快照，但快照只是备份，不是回滚保护；
  不想被改写就用 tarball 安装，或先把工作区提交干净。

## [1.0.1] - 2026-10-21

### Added

- Announcement feed mirrors: when `raw.githubusercontent.com` is unreachable the
  loader retries the GitHub contents API (base64 payload) and the `ghproxy.net`
  raw mirror, in that order.
- `feedMirrors` configuration key for extra feed locations.
- Bundled fallback: when every remote source fails, the `announcements.json`
  shipped inside the installed package is used, so announcements keep working
  with no network at all (`bundledAnnouncements: false` disables it).
- `sunder_status` now reports the feed source and the last feed error.

## [1.0.0] - 2026-10-21

### Added

- `dsh-sunder` bundle: replaces the deployment persona with the Sunder prompt
  pack (`sunder:identity` before the persona prefix, `sunder:rules` after the
  tool sections, `sunder:footer` after the persona suffix), so the next request
  of an already-open conversation picks it up without starting a new chat.
- Prompt pack in Chinese and English (`language: "zh" | "en"`, defaults to `zh`),
  with an `extraPrompt` slot for user additions.
- Announcement centre: fetches `announcements.json` from the repository, filters
  entries by the running version, surfaces unread notices in the runtime context
  and exposes them through the `sunder_notice` tool (`list` / `ack`).
- Self-update control: checks the GitHub Releases API at most once per
  `updateIntervalHours`, caches the result in `$DSH_HOME/sunder/state.json`,
  reports newer versions in the runtime context and through `sunder_status` /
  `sunder_update`.
- `sunder_status` tool: one call reports the running version, prompt state, feed
  cache, and unread announcements.
- `scripts/release.mjs`: version bump, changelog stub, commit, tag, push and
  `gh release create` in one command.
- GitHub Actions: CI (tests) and a release workflow that publishes a GitHub
  Release whenever a `v*` tag is pushed.
- Offline tests for the version range logic, announcement selection, prompt
  composition, and the real `@deepseek-ai/dsh-system-prompt` integration.

[Unreleased]: https://github.com/menghuanshiguang/dsh-sunder/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.1.0
[1.0.1]: https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.0.1
[1.0.0]: https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.0.0
