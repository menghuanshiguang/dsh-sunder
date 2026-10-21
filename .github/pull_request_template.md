## 变更说明

<!-- 这个 PR 改了什么、为什么改。一两段就够，细节放后面的检查项里。 -->

## 关联 issue

<!-- Closes #123 / Fixes #456；没有就写「无」 -->

## 变更类型

- [ ] 修复（不改变现有行为，只修 bug）
- [ ] 新功能（新增配置项、工具、预设或面板能力）
- [ ] 破坏性变更（需要用户改配置或重新安装）
- [ ] 文档 / 模板 / CI
- [ ] 重构（不改行为）

## 测试

本地跑过哪些，结果如何（贴命令与关键输出，不要只写"通过了"）：

```powershell
node test/unit.mjs
node test/prompt.mjs
node test/install.mjs     # 若存在
node test/update.mjs      # 若存在
node test/client.mjs      # 若存在
node test/smoke.mjs       # 有本机 DSH 运行时才有意义，否则自动 skip
node scripts/check-package.mjs
```

CI 会跑上面的命令（`windows-latest`，Node 20 与 22），缺失的测试文件自动跳过。

## 影响面

- [ ] 改了提示词文案或 `preset`（说明哪一段、为什么）
- [ ] 改了 `SECTION_ORDERS` 里的位置（高危：会改变整份系统提示的阅读顺序，请说明理由）
- [ ] 改了 `cordis.patch.yml`（说明新增/移除的行，以及是否影响 `includeHarnessIdentity`）
- [ ] 改了 `state.json` 的结构（必须同时升 `schema` 并在 `loadState()` 里做兼容）
- [ ] 改了安装脚本（请确认对已有 profile 幂等，且 `--dry-run` 不写盘）
- [ ] 新增运行时依赖（默认不允许：插件目前零依赖）
- [ ] 改了 `package.json` 的 `files` / `exports`（同步更新 `scripts/check-package.mjs`）

## 检查清单

- [ ] 三段提示词的 `interpolate` 仍为 `false`，文案里没有 `{{ … }}` 模板变量（`test/prompt.mjs` 会断言）
- [ ] 文案改动同时给了 `zh` 与 `en` 两个版本
- [ ] 失败路径不抛异常：网络、状态写入、补段失败都要降级并留日志
- [ ] 相关文档已更新（README 配置表 / docs/TROUBLESHOOTING.md / docs/ARCHITECTURE.md）
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 下已添加条目
- [ ] 没有提交 `node_modules`、`package.json.bak-*`、`*.tgz`、`state.json` 或本地绝对路径
- [ ] 没有在文档里写英文正文（本项目文档一律中文，命令与标识符保持原样）

## 截图 / 日志

<!-- 涉及 UI、提示词顺序或报错时贴一下 -->
