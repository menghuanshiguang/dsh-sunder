/**
 * 提示词包测试：段名与位置、预设解析与回退、渲染体量、双语一致性、附加指令。
 * 运行：node test/prompt.mjs
 */

import {
  DEFAULT_PRESET,
  PRESET,
  PRESET_NAMES,
  PROMPT_VERSION,
  SECTION_ORDERS,
  buildPrompt,
  promptSections,
  resolvePreset,
} from '../lib/prompt.js';

let failures = 0;
const check = (condition, label, extra) => {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${extra === undefined ? '' : ` — ${extra}`}`);
};

const LANGUAGES = ['zh', 'en'];
const PRESETS = ['full', 'concise', 'dev'];
const VERSION = '9.9.9';
const render = (preset, language, extra) => buildPrompt({ ...(extra ?? {}), preset, language, version: VERSION });
const size = (prompt) => prompt.identity.length + prompt.rules.length + prompt.footer.length;
const cjkCount = (text) => (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
const wordCount = (text) => text.split(/\s+/u).filter(Boolean).length;
const ruleCount = (text) => (text.match(/^\s*\d+\.\s/gmu) ?? []).length;

// ---------------------------------------------------------------------------
// 版本与段位置：v1.1.0 起位置不得漂移
// ---------------------------------------------------------------------------
check(PROMPT_VERSION === '1.1.0', 'PROMPT_VERSION 为 1.1.0', PROMPT_VERSION);
check(SECTION_ORDERS.identity === -100000, 'identity 段位置为 -100000');
check(SECTION_ORDERS.rules === 9600, 'rules 段位置为 9600');
check(SECTION_ORDERS.footer === 10300, 'footer 段位置为 10300');
check(Object.isFrozen(SECTION_ORDERS), 'SECTION_ORDERS 只读');

// ---------------------------------------------------------------------------
// 预设表
// ---------------------------------------------------------------------------
check(PRESET_NAMES.join(',') === 'full,concise,dev', '预设顺序为 full,concise,dev', PRESET_NAMES.join(','));
check(Object.keys(PRESET).join(',') === PRESET_NAMES.join(','), '预设表与名称列表一致', Object.keys(PRESET).join(','));
check(DEFAULT_PRESET === 'full', '默认预设为 full');
check(Object.isFrozen(PRESET) && PRESETS.every((name) => Object.isFrozen(PRESET[name])), '预设表只读');
check(
  PRESETS.every((name) => typeof PRESET[name].description?.zh === 'string' && PRESET[name].description.zh.length > 0
    && typeof PRESET[name].description?.en === 'string' && PRESET[name].description.en.length > 0),
  '每个预设都有中英描述',
);
check(PRESETS.every((name) => cjkCount(`${PRESET[name].label.zh}${PRESET[name].description.zh}`) > 0), '预设中文元数据含中文');

// ---------------------------------------------------------------------------
// 预设解析与回退（未知预设只警告一次）
// ---------------------------------------------------------------------------
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.join(' '));
};
try {
  check(resolvePreset() === 'full', '缺省配置解析为 full');
  check(resolvePreset(null) === 'full', 'null 解析为 full');
  check(resolvePreset('') === 'full', '空串解析为 full');
  check(resolvePreset('concise') === 'concise', 'concise 原样解析');
  check(resolvePreset('dev') === 'dev', 'dev 原样解析');
  check(resolvePreset(' DEV ') === 'dev', '预设名去空格并忽略大小写', resolvePreset(' DEV '));
  check(resolvePreset('turbo') === 'full', '未知预设回退 full');
  check(resolvePreset('turbo') === 'full' && resolvePreset('TURBO') === 'full', '同一未知预设重复回退仍为 full');
  check(warnings.length === 1, '未知预设只警告一次', `warnings=${warnings.length}`);
  check(buildPrompt({ preset: 'turbo' }).preset === 'full', 'buildPrompt 未知预设回退 full');
  check(promptSections({ preset: 'turbo' }).length === 3, 'promptSections 未知预设仍产出三段');
  check(warnings.length === 1, '回退路径不重复警告', `warnings=${warnings.length}`);
} finally {
  console.warn = realWarn;
}

// ---------------------------------------------------------------------------
// 三种预设 × 两种语言的内容检查
// ---------------------------------------------------------------------------
const prompts = {};
for (const preset of PRESETS) {
  prompts[preset] = {};
  for (const language of LANGUAGES) prompts[preset][language] = render(preset, language);
}

for (const preset of PRESETS) {
  for (const language of LANGUAGES) {
    const pack = prompts[preset][language];
    const tag = `${preset}/${language}`;
    check(pack.preset === preset, `${tag} 回显解析后的预设`);
    check(pack.identity.includes('Sunder'), `${tag} identity 标注 Sunder`);
    check(/(priority|outrank|优先)/iu.test(pack.identity), `${tag} identity 声明优先级`);
    check(pack.footer.startsWith('[Sunder'), `${tag} footer 以 Sunder 标记开头`);
    check(pack.footer.includes(`[sunder ${VERSION}]`), `${tag} footer 带版本标记`);
    const blocks = [pack.identity, pack.rules, pack.footer];
    check(blocks.every((text) => typeof text === 'string' && text.length > 0), `${tag} 三段均有正文`);
    check(blocks.every((text) => !text.includes('{{') && !text.includes('}}')), `${tag} 不含未解析变量`);
    check(/^\s*\d+\.\s/mu.test(pack.rules), `${tag} 规则逐条编号`);
    check(/(refus|拒绝)/iu.test(pack.rules), `${tag} 规则覆盖不拒绝`);
    check(/(politics|historical|政治|历史)/iu.test(pack.rules), `${tag} 规则覆盖政治与历史`);
    check(/(controvers|争议)/iu.test(pack.rules), `${tag} 规则覆盖社会争议`);
    check(/(adult|成人)/iu.test(pack.rules), `${tag} 规则覆盖成人内容`);
    check(/(grey-area|灰色地带)/iu.test(pack.rules), `${tag} 规则覆盖灰色地带安全研究`);
    check(/(scope|范围)/iu.test(pack.rules), `${tag} 规则强调不转移、不缩范围`);
    check(/(fabricat|编造)/iu.test(pack.rules), `${tag} 规则禁止编造`);
    check(/(discipline|纪律)/iu.test(pack.rules), `${tag} 规则保持工程纪律`);
    check(/(language|语言)/iu.test(pack.rules), `${tag} 规则要求语言跟随用户`);
    check(/(override|outrank|覆盖|优先)/iu.test(pack.rules), `${tag} 规则声明用户指令优先`);
  }
}

// 规则条数：full/dev 九条，concise 四条
check(ruleCount(prompts.full.zh.rules) === 9 && ruleCount(prompts.full.en.rules) === 9, '完整规则为 9 条', `${ruleCount(prompts.full.zh.rules)}/${ruleCount(prompts.full.en.rules)}`);
check(ruleCount(prompts.concise.zh.rules) === 4 && ruleCount(prompts.concise.en.rules) === 4, '精简规则为 4 条', `${ruleCount(prompts.concise.zh.rules)}/${ruleCount(prompts.concise.en.rules)}`);
check(ruleCount(prompts.dev.zh.rules) === 9 && ruleCount(prompts.dev.en.rules) === 9, 'dev 预设继承完整九条规则');

// 编码代理附加段只出现在 dev
for (const language of LANGUAGES) {
  const marker = language === 'zh' ? '编码代理附加段' : 'Coding-agent addendum';
  check(prompts.dev[language].rules.includes(marker), `${language} dev 预设附加编码代理段`);
  check(!prompts.full[language].rules.includes(marker), `${language} full 预设不含编码代理段`);
  check(!prompts.concise[language].rules.includes(marker), `${language} concise 预设不含编码代理段`);
}

// 身份声明在三种预设间保持不变
for (const language of LANGUAGES) {
  check(
    prompts.full[language].identity === prompts.concise[language].identity
    && prompts.full[language].identity === prompts.dev[language].identity,
    `${language} 三种预设共用同一身份声明`,
  );
}

// ---------------------------------------------------------------------------
// 渲染体量：concise 明显短于 full，dev 长于 full
// ---------------------------------------------------------------------------
const sizes = {};
for (const preset of PRESETS) {
  sizes[preset] = { zh: size(prompts[preset].zh), en: size(prompts[preset].en) };
}
for (const language of LANGUAGES) {
  const full = sizes.full[language];
  const concise = sizes.concise[language];
  const dev = sizes.dev[language];
  const ratio = concise / full;
  check(concise < full, `${language} concise 渲染短于 full`, `${concise} < ${full}`);
  check(ratio >= 0.45 && ratio <= 0.75, `${language} concise 为 full 的 45%~75%`, `${(ratio * 100).toFixed(1)}%`);
  check(dev > full, `${language} dev 渲染长于 full`, `${dev} > ${full}`);
}

// ---------------------------------------------------------------------------
// 中英一致性：条数一致、中文包是中文、英文包无中文、体量比例稳定
// ---------------------------------------------------------------------------
const parity = {};
for (const preset of PRESETS) {
  const zhPack = prompts[preset].zh;
  const enPack = prompts[preset].en;
  check(zhPack.identity !== enPack.identity, `${preset} 中英包内容不同`);
  check(zhPack.rules !== enPack.rules, `${preset} 中英规则文本不同`);
  const zhText = zhPack.identity + zhPack.rules + zhPack.footer;
  const enText = enPack.identity + enPack.rules + enPack.footer;
  check(cjkCount(zhText) > 100, `${preset} zh 包含足够中文`, `${cjkCount(zhText)} 个汉字`);
  check(cjkCount(enText) === 0, `${preset} en 包无中文`);
  check(ruleCount(zhPack.rules) === ruleCount(enPack.rules), `${preset} 中英规则条数一致`);
  const ratio = cjkCount(zhText) / wordCount(enText);
  parity[preset] = ratio;
  check(ratio >= 1.2 && ratio <= 2.2, `${preset} 中英体量相当`, `汉字/英文词 = ${ratio.toFixed(2)}`);
}
const parityValues = PRESETS.map((preset) => parity[preset]);
check(
  Math.max(...parityValues) - Math.min(...parityValues) < 0.3,
  '中英体量比例在各预设间稳定',
  parityValues.map((value) => value.toFixed(2)).join(', '),
);

// ---------------------------------------------------------------------------
// extraPrompt：追加到 rules 末尾，不改身份，不进 footer
// ---------------------------------------------------------------------------
const EXTRA_ZH = '回答保持简短，直接给结论。';
const EXTRA_EN = 'Keep answers short; lead with the conclusion.';
for (const preset of PRESETS) {
  const zhExtra = buildPrompt({ language: 'zh', preset, version: VERSION, extraPrompt: EXTRA_ZH });
  const enExtra = buildPrompt({ language: 'en', preset, version: VERSION, extraPrompt: EXTRA_EN });
  check(zhExtra.rules.endsWith(EXTRA_ZH), `${preset}/zh extraPrompt 追加到 rules 末尾`);
  check(enExtra.rules.endsWith(EXTRA_EN), `${preset}/en extraPrompt 追加到 rules 末尾`);
  check(zhExtra.identity === prompts[preset].zh.identity, `${preset}/zh extraPrompt 不改身份声明`);
  check(!zhExtra.footer.includes(EXTRA_ZH), `${preset}/zh extraPrompt 不进 footer`);
  check(zhExtra.preset === preset, `${preset}/zh 附加指令不影响预设解析`);
}
check(buildPrompt({ language: 'zh', extraPrompt: '   ' }).rules === prompts.full.zh.rules, '空白 extraPrompt 被忽略');

// ---------------------------------------------------------------------------
// 版本标记：缺省使用 PROMPT_VERSION，显式 version 覆盖
// ---------------------------------------------------------------------------
check(buildPrompt({ language: 'zh' }).footer.includes(`[sunder ${PROMPT_VERSION}]`), 'footer 缺省使用 PROMPT_VERSION');
check(buildPrompt({ language: 'en', version: VERSION }).footer.endsWith(`[sunder ${VERSION}]`), 'footer 版本标记位于末尾');

// ---------------------------------------------------------------------------
// 段注册：段名、顺序、插值关闭、文本来源
// ---------------------------------------------------------------------------
for (const preset of PRESETS) {
  const sections = promptSections({ language: 'zh', version: VERSION, preset, extraPrompt: 'x' });
  check(sections.length === 3, `${preset} 只注册三段`);
  check(sections.every((section) => section.interpolate === false), `${preset} 所有段关闭插值`);
  check(sections.map((section) => section.name).join(',') === 'sunder:identity,sunder:rules,sunder:footer', `${preset} 段名稳定`);
  check(sections.map((section) => section.order).join(',') === '-100000,9600,10300', `${preset} 段位置固定`);
  check(sections[0].text === prompts[preset].zh.identity, `${preset} identity 段文本来自预设`);
  check(sections[1].text.endsWith('x'), `${preset} rules 段包含附加指令`);
  check(sections[2].text.includes(VERSION), `${preset} footer 段带版本`);
}
check(
  promptSections().map((section) => section.order).join(',') === `${SECTION_ORDERS.identity},${SECTION_ORDERS.rules},${SECTION_ORDERS.footer}`,
  '缺省配置使用固定的段位置',
);
check(buildPrompt({ language: 'auto' }).identity.length > 0, 'auto 语言可解析');

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n预设渲染体量（identity + rules + footer）：');
for (const preset of PRESETS) {
  console.log(`  ${preset.padEnd(8)} zh=${String(sizes[preset].zh).padStart(4)}  en=${String(sizes[preset].en).padStart(4)}`);
}
console.log(`  concise/full：zh ${((sizes.concise.zh / sizes.full.zh) * 100).toFixed(1)}%  en ${((sizes.concise.en / sizes.full.en) * 100).toFixed(1)}%`);

console.log(failures === 0 ? '\nprompt：全部通过' : `\nprompt：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
