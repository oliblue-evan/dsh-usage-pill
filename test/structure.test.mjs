/**
 * 结构契约：`client.js` 的单文件组织方式必须可被测试可靠地切开。
 *
 * 客户端 bundle 是单文件（宿主把它拼进 combo 脚本、以传统脚本执行），所以"纯逻辑"
 * 与"界面"的边界只能靠标记声明。这里把这份约定钉住：
 *   · 标记各出现一次（多了/少了都说明结构被动过）；
 *   · 区块里确实有测试需要的那些符号；
 *   · 区块里**不许出现 React / DOM**（那是它能被 `new Function` 直接求值的前提）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientSource, pureLogicBlock } from './extract-client.mjs';

/** 测试要用到的符号（`client-math` / `pricing-parity` 都依赖它们）。 */
const REQUIRED = [
  'BJ_OFFSET_MS', 'PEAK_WINDOWS', 'CN_STATUTORY_HOLIDAYS', 'PRICE_SCHEDULES',
  'isPeakAt', 'beijingClock', 'nextSwitchAt', 'tierOfModel', 'scheduleAt', 'costOf',
  'totalTokens', 'fmtCountdown', 'fmtBeijing', 'fmtExactTokens', 'fmtMoney', 'symbolOf',
  'fromAccountBalance', 'fromKeyBalance',
];

test('纯逻辑标记各出现一次', () => {
  const source = clientSource();
  assert.equal(source.split('// #region 纯逻辑').length - 1, 1);
  assert.equal(source.split('// #endregion 纯逻辑').length - 1, 1);
});

test('纯逻辑区块包含测试依赖的全部符号', () => {
  const block = pureLogicBlock();
  const missing = REQUIRED.filter((name) => !new RegExp('(function|const)\\s+' + name + '\\b').test(block));
  assert.deepEqual(missing, [], '这些符号不在纯逻辑区块里了：' + missing.join(', '));
});

test('纯逻辑区块不含 React / DOM（这是它能被直接求值的前提）', () => {
  // 只看代码行：标记行自己就写着"不含 React/DOM"，注释会把自己判成违规
  const code = pureLogicBlock()
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const forbidden of ['React', 'document.', 'window.', 'useState', 'useEffect']) {
    assert.ok(!code.includes(forbidden), '纯逻辑区块里出现了 ' + forbidden + '，应移到界面区块');
  }
});

test('文件头保留了目录与"单文件"理由', () => {
  const source = clientSource();
  assert.ok(source.includes('本文件的组织方式'), '文件头目录被删了');
  assert.ok(/combo 脚本/.test(source), '应说明为什么 bundle 必须是单文件');
});

test('样式在插件级注入一次，而不是塞在某个槽位的组件树里', () => {
  const source = clientSource();
  // 踩过的坑：<style> 原先放在徽标组件的返回树里，而设置卡是在**另一个槽位**
  // （插件页的 plugins.bundle.config）渲染的 —— 那边一个样式都拿不到，
  // 整张卡退化成挤成一行的裸文字 + 原生复选框。所以样式必须挂在插件 fiber 上。
  assert.match(
    source,
    /ctx\.effect\(\(\) => \{\s*const style = document\.createElement\('style'\)/,
    '缺少插件级样式注入（ctx.effect + document.createElement(\'style\')）',
  );
  assert.ok(
    !/h\('style', null, CSS\)/.test(source),
    '不应再在组件树里渲染 <style>：其它槽位的组件拿不到它',
  );
});

test('开关与官方 Switch 同构（button + role=switch + 官方 token）', () => {
  const source = clientSource();
  assert.match(source, /role: 'switch'/, '开关应是 role="switch" 的按钮（官方 @deepseek-ai/dsh-client-ui-primitives 的做法）');
  assert.match(source, /'aria-checked': checked/, '状态由 aria-checked 表达，视觉与无障碍同源');
  assert.ok(
    !/className: 'umSettingInput'/.test(source),
    '不应再用 input[type=checkbox]：宿主有它的全局样式，特异性压得过类选择器',
  );
  const start = source.indexOf('.umSwitch{');
  assert.ok(start >= 0, '找不到 .umSwitch 规则');
  const rule = source.slice(start, source.indexOf('}', start) + 1);
  assert.match(rule, /width:36px;height:20px;padding:2px/, '尺寸应与官方 36×20 / padding 2px 一致');
  assert.match(rule, /background:var\(--dsw-alias-border-l3\)/, '关态轨道用官方的 border-l3');
  assert.ok(
    source.includes(".umSwitch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}"),
    '开态轨道用品牌色（官方同款）',
  );
  assert.match(source, /--dsw-alias-switch-thumb/, '圆钮用官方的 switch-thumb token');
});

test('分隔点与官方同构：包在 label 里，不是 pill 的平级 flex 子元素', () => {
  const source = clientSource();
  // 官方把 `·` 放进 inline 的 label span；平级放会让 pill 的 gap:6px 叠加到
  // .umSep 的 margin:0 6px 上，点两侧变成 12px（实测比官方宽一倍）。
  assert.match(
    source,
    /h\('span', \{ className: 'umLabel' \}, labelParts\)/,
    '文字段与分隔点应同包在一个 umLabel span 里',
  );
  assert.match(source, /\.umSep\{color:var\(--dsw-alias-separator-primary\);margin:0 6px\}/, '间距数值应与官方一致（0 6px）');
  // 不应再出现"平级塞分隔点"的老写法
  assert.ok(
    !/pillParts\.forEach\(\(node, index\)/.test(source),
    '不应把分隔点平级塞进 pill 的 flex 子元素列表',
  );
});

test('胶囊与真圆必须显式退出全局超椭圆（corner-shape:round）', () => {
  const source = clientSource();
  // 主题对 `*,:before,:after` 施加 corner-shape:superellipse(1.5)（见 dsh-client-ui-theme），
  // 超椭圆会把胶囊两侧压平 —— 官方 Switch.module.css 里正因如此写了 corner-shape:round。
  // 凡是 border-radius:999px 或 50% 的规则都要跟着写，否则开关、胶囊、"现在"圆点会看起来偏方。
  const start = source.indexOf('const CSS = `');
  const css = source.slice(start, source.indexOf('`;', start));
  const rules = css.match(/\{[^{}]*\}/g) ?? [];
  const offenders = rules.filter((rule) => /border-radius:(999px|50%)/.test(rule) && !/corner-shape:round/.test(rule));
  assert.deepEqual(
    offenders,
    [],
    '这些规则用了胶囊/真圆圆角却没写 corner-shape:round：\n' + offenders.map((r) => r.slice(0, 90)).join('\n'),
  );
  assert.ok(
    (css.match(/corner-shape:round/g) ?? []).length >= 4,
    '至少四处：胶囊 .umPill、圆点 .umDot、开关轨道 .umSwitch、开关圆钮 .umSwitchThumb',
  );
});
