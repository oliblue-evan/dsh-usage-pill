/**
 * 宿主计价内核的断言：时段判定、价目分段、桶映射、单笔计价、事件取用量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketsFromUsage, costOfBuckets, isPeakAt, rateAt, tierOfModel, usageOfEvent,
} from '../lib/pricing.js';

/** 北京时间某时刻对应的 UTC 毫秒。 */
const bj = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);

test('高峰窗口：左闭右开，周末与法定节假日整天低峰', () => {
  assert.equal(isPeakAt(bj(2026, 9, 29, 8, 59)), false, '周二 08:59 应空闲');
  assert.equal(isPeakAt(bj(2026, 9, 29, 9, 0)), true, '周二 09:00 应高峰');
  assert.equal(isPeakAt(bj(2026, 9, 29, 11, 59)), true);
  assert.equal(isPeakAt(bj(2026, 9, 29, 12, 0)), false, '12:00 是右开端点');
  assert.equal(isPeakAt(bj(2026, 9, 29, 14, 0)), true);
  assert.equal(isPeakAt(bj(2026, 9, 29, 18, 0)), false, '18:00 是右开端点');
  assert.equal(isPeakAt(bj(2026, 9, 19, 10, 0)), false, '周六应空闲');
  assert.equal(isPeakAt(bj(2026, 10, 1, 10, 0)), false, '国庆应空闲');
  assert.equal(isPeakAt(bj(2026, 9, 25, 10, 0)), false, '中秋（周五）应空闲');
  assert.equal(isPeakAt(bj(2026, 10, 8, 10, 0)), true, '节后周四应恢复高峰');
  assert.equal(isPeakAt(Number.NaN), false);
});

test('档位识别：含 flash 走 flash，其余（含未知）走 pro', () => {
  assert.equal(tierOfModel('deepseek-v4-flash'), 'flash');
  assert.equal(tierOfModel('DeepSeek-V4-Flash-0731'), 'flash');
  assert.equal(tierOfModel('deepseek-v4-pro'), 'pro');
  assert.equal(tierOfModel(undefined), 'pro');
});

test('价格政策时间线：三段各自取价，峰谷倍率 2，平价段不翻倍', () => {
  // 8/17 之前：平价段（peakMultiplier = 1）
  const flat = rateAt('deepseek-flash', bj(2026, 8, 1, 10, 0));
  assert.equal(flat.regime, 'flat');
  assert.equal(flat.multiplier, 1);
  assert.equal(flat.miss, 1);

  // 8/17–9/10：flash 空闲 0.05/1.5/4.5，高峰 ×2
  assert.equal(rateAt('deepseek-flash', bj(2026, 8, 20, 8, 0)).miss, 1.5);
  assert.equal(rateAt('deepseek-flash', bj(2026, 8, 20, 10, 0)).miss, 3);

  // 9/10 12:00 之后：flash 空闲 0.02/1/4，高峰 0.04/2/8
  const off = rateAt('deepseek-flash', bj(2026, 9, 11, 8, 0));
  const peak = rateAt('deepseek-flash', bj(2026, 9, 11, 10, 0));
  assert.deepEqual([off.hit, off.miss, off.out], [0.02, 1, 4]);
  assert.deepEqual([peak.hit, peak.miss, peak.out], [0.04, 2, 8]);
  assert.equal(peak.regime, 'peak');
  assert.equal(off.regime, 'off');

  // pro 档
  const proOff = rateAt('deepseek-v4-pro', bj(2026, 9, 11, 8, 0));
  const proPeak = rateAt('deepseek-v4-pro', bj(2026, 9, 11, 10, 0));
  assert.deepEqual([proOff.hit, proOff.miss, proOff.out], [0.15, 4.5, 13.5]);
  assert.deepEqual([proPeak.hit, proPeak.miss, proPeak.out], [0.3, 9, 27]);
});

test('usage → 四个桶', () => {
  assert.deepEqual(
    bucketsFromUsage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 }),
    { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
  );
  assert.deepEqual(bucketsFromUsage(undefined), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.deepEqual(bucketsFromUsage({ inputTokens: '7' }), { input: 7, cacheRead: 0, cacheWrite: 0, output: 0 });
});

test('单笔计价：缓存写入按未命中单价计', () => {
  const rate = rateAt('deepseek-flash', bj(2026, 9, 11, 10, 0)); // 高峰：0.04/2/8
  const cost = costOfBuckets({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, rate);
  assert.equal(cost.hit, 0.04);
  assert.equal(cost.miss, (1e6 + 1e6) * 2 / 1e6, '未命中与写入同按 miss 价');
  assert.equal(cost.out, 8);
  assert.equal(cost.total, 0.04 + 4 + 8);
  assert.equal(cost.regime, 'peak');
});

test('取用量：优先 data.usage，其次 stream 里最后一个 usage chunk', () => {
  const usage = { inputTokens: 5 };
  assert.equal(usageOfEvent({ type: 'assistant/message', data: { usage } }), usage);
  assert.equal(usageOfEvent({
    type: 'assistant/attempt',
    data: { stream: [{ type: 'chunk', chunk: { type: 'text-delta' } }, { type: 'chunk', chunk: { type: 'usage', usage } }] },
  }), usage, '应从后往前取最后一个 usage');
  assert.equal(usageOfEvent({ type: 'assistant/attempt', data: { stream: [] } }), undefined);
  assert.equal(usageOfEvent({ type: 'tool/result', data: { usage } }), undefined, '非 assistant 事件不取');
  assert.equal(usageOfEvent(null), undefined);
});
