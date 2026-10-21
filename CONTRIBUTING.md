# 贡献指南（Contributing to dsh-sunder）

`dsh-sunder` 是 DSH 的一个 bundle：它替换部署 persona 的提示词、拉取发布公告、检查并应用
自更新，还带一个浏览器端设置卡片和公告横幅。改动会直接影响每一轮请求的提示词和用户本机的
profile，所以流程比普通小库严一点——但只需要 Node 和下面几条命令。

- 提 PR 之前请先读：`README.md`、`docs/ARCHITECTURE.md`、`docs/TROUBLESHOOTING.md`、
  `docs/PROMPTS.md`、`SECURITY.md`。
- 提 PR 时请顺手说清：动机、改了什么、怎么验证的（命令 + 输出）。

## 环境

| 项 | 要求 |
| --- | --- |
| Node | `>= 18`（`package.json` 的 `engines.node`）；CI 跑 20 / 22 |
| 依赖 | 无。零运行时依赖，仓库里没有 `package-lock.json`，也没有安装/构建步骤 |
| 可选 DSH 运行时 | 只有 `test/smoke.mjs` 需要；没有就自动跳过 |
| 网络 | 跑测试不需要。`doctor` 的 feed / update 两项可用 `--no-network` 跳过 |

```powershell
node --version          # 期望 v18 及以上
npm test                # 全链，见下
```

可选的运行时位置（任选其一，顺序即优先级）：

1. `test/smoke.mjs` / `scripts/doctor.mjs` 的 `--runtime <dir>` 参数；
2. 环境变量 `DSH_RUNTIME_DIR`；
3. 默认目录 `D:\DSHPC\resources\app\dsh`（`scripts/doctor.mjs` 里的 `DEFAULT_RUNTIME_DIR`）。

注意：`D:\DSHPC` 是本机 DSH 的**安装目录**，不是本仓库，见下文"不要碰的东西"。

## 跑测试

```powershell
npm test                                  # = 下面整条链，顺序固定
node test/unit.mjs                        # 版本比较、公告筛选、状态文件、提示词分段
node test/prompt.mjs                      # 三档预设的渲染、order、extraPrompt、未知预设回退
node test/client.mjs                      # 浏览器端注册、状态序列化、横幅选择
node test/install.mjs                     # 在 tmpdir 假 profile 里跑完整安装 / 卸载 / 回滚
node test/update.mjs                      # applyUpdate：源码包、contents API 兜底、包名不符、已是最新
node test/doctor.mjs                      # 诊断 CLI：十项检查、退出码、--json
node test/smoke.mjs                       # 真实 DSH 运行时上的集成冒烟（没有运行时会 skip）
node scripts/check-package.mjs            # 打包契约：manifest、JSON、版本与 CHANGELOG 一致性
```

- 只跑一个文件时，直接 `node test/<name>.mjs`，失败会打印 `FAIL <断言>` 与退出码 1。
- `test/smoke.mjs` 找不到运行时会打印 `smoke: skipped (no DSH runtime at …, set DSH_RUNTIME_DIR to run it)` 并以 0 退出——
  CI 里就是这样跳过的，别把它改成"缺运行时即失败"。
- `npm test` 里 `scripts/check-package.mjs` 排最后，因为它校验 `CHANGELOG.md` 是否含当前版本条目。

## 先跑 doctor，再报 bug

```powershell
npm run doctor                            # 十项检查，人读
npm run doctor -- --json                  # 机读，贴 issue 用
node scripts/doctor.mjs --no-network      # 断网 / 内网环境
node scripts/doctor.mjs --profile <dir> --runtime <dir>
```

`doctor` 是只读的：不建目录、不改 `package.json`、不动 `state.json`，也不触发安装或更新。
检查项依次是 node / profile / bundle / link / manifest / composition / feed / update / state / version，
每项状态为 `ok` / `warn` / `FAIL` / `skip`；退出码 `0` = 健康（允许 warn）、`1` = 有 fail、`2` = 用法错误。

## 仓库结构

```
index.js                 # 插件入口：config schema、sunder_* 工具、提示词分段注册
lib/prompt.js            # 三档预设与中英文提示词正文（buildPrompt / promptSections）
lib/announcements.js     # feed 拉取、镜像兜底、内置 feed、版本区间筛选
lib/update.js            # release 查询、缓存、applyUpdate（快照 + 包名校验后写盘）
lib/version.js           # 版本比较与区间判断
lib/state.js             # $DSH_HOME/sunder/state.json 的读写与迁移
lib/net.js               # 出网请求（GET only，带超时）
lib/client.js            # 浏览器端：settings 分区 + 公告横幅（只读）
cordis.patch.yml         # bundle 补丁：把 dsh-sunder 插进 profile 的 bundles
locale/{zh,en}.json      # UI 文案（含 presets 的 label/description）
docs/                    # ARCHITECTURE / TROUBLESHOOTING / PROMPTS
scripts/                 # install / uninstall / doctor / check-package / release / publish-api
test/                    # 离线测试（unit / prompt / client / install / update / doctor / smoke）
.github/                 # issue / PR 模板与 ci / release / codeql 工作流
announcements.json       # 随包公告 feed（发版时改）
```

## 提 PR 的规矩

1. **小步**：一个 PR 一个主题。顺手重排、顺手格式化整个文件会把 review 淹没，请单独提。
2. **先测**：行为改动要带 `test/` 里能跑的断言；修 bug 先写能复现的用例，再改实现。
   改了提示词正文就更新 `test/prompt.mjs` 里对应的结构断言（不是逐字快照）。
3. **不提交 profile 改动**：`<profile>/package.json`、`package.json.bak-<时间戳>`、
   `node_modules/dsh-sunder`（junction 或副本）、`$DSH_HOME/sunder/state.json` 与
   `backups/` 都是本机状态，永远不进仓库。提交前用 `git status` 确认干净。
4. **不碰 `D:\DSHPC`**：那是本机 DSH 的安装目录。不要在里面改文件、不要提交它、
   也不要用 `sunder_update action="apply"` 拿它做验证——`applyUpdate()` 会写进当前安装目录，
   而用 `link:` / junction 挂载时"安装目录"就是本仓库工作区。
5. **`CHANGELOG.md` 与 `announcements.json` 的发布条目只在发版时改**：功能 PR 不动版本号、
   不加新条目、不改 `[Unreleased]` 段；`package.json` 的 `version` 由 `scripts/release.mjs` 统一处理。
6. **中英文成对更新**：改了 `README.md` 就同步 `README.en.md` 与 `locale/{zh,en}.json`；
   新增用户可见文案时两个语言都要有。
7. **提交信息**：沿用现有风格——`feat: …` / `fix: …` / `docs: …` / `test: …`，一行说清做了什么。
8. **PR 描述里贴证据**：`npm test` 结果、`npm run doctor -- --json` 的相关几项、以及复现步骤。

## 本地试用（不污染全局）

两个脚本都接受 `-p` / `--profile`、`--repo`、`-n` / `--dry-run`、`-h` / `--help`；
`install.mjs` 另有 `-u` / `--uninstall`（等价于跑 `uninstall.mjs`）。

```powershell
# 1) 先看它打算做什么：dry-run 不写盘、不建备份
node scripts/install.mjs -n

# 2) 指定 profile 再看一遍
node scripts/install.mjs -n -p "$env:DSH_HOME/profiles/desktop"

# 3) 真正挂载：写 node_modules/dsh-sunder 链接、dependencies 的 link: 条目、
#    dsh.profile.bundles；改 package.json 前留 package.json.bak-<时间戳>
node scripts/install.mjs

# 4) 卸载：反向操作，先 dry-run 再执行（junction 只解链，不跟进删除）
node scripts/uninstall.mjs -n
node scripts/uninstall.mjs
```

挂载是幂等的：重复执行不会叠加备份，也不会把 `dsh-sunder` 重复写进 `bundles`。
用 junction 挂载时，安装目录就是本仓库，所以改完 `index.js` / `lib/*` 只需重启 DSH，不用重装。

## 文档改动

- 中文为主，英文放 `README.en.md` 与 `locale/en.json`；`docs/` 里的文档同样给中文正文。
- 示例命令必须能直接复制运行；不要写依赖第三方 CLI 的步骤（本项目零依赖，脚本只用 `node:` 内置模块）。
- 写"行为"时以 `index.js` / `lib/*` 为准：工具输出格式、配置键默认值、退出码都要和代码对得上。

## 许可

本项目以 MIT 发布（见 `LICENSE`）。提交 PR 即表示你同意你的贡献以同样的 MIT 条款发布。
