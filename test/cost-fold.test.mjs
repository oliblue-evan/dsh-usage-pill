/**
 * usagePillCost 折叠的断言 —— 这是"金额按实际发生额"这条修复的核心。
 *
 * 重点覆盖三件容易做错的事：
 *   · 每笔用量按**它自己那一刻**的峰谷计价（不是按"现在"）；
 *   · 每笔用量按**它当时那个模型**计价（中途换模型不改写历史）；
 *   · 同一 turn+step 后到替换先到，而 llm/retry-started 之后的重试要累加。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initState, viewOf } from '../lib/cost-fold.js';

/** 北京时间某时刻对应的 UTC 毫秒。 */
const bj = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);
/** 周二 10:00（高峰）与 08:00（空闲）。 */
const PEAK = bj(2026, 9, 29, 10, 0);
const OFF = bj(2026, 9, 29, 8, 0);

/** 一条 request/header。 */
const route = (model) => ({ type: 'request/header', time: PEAK, data: { header: { config: { provider: 'deepseek', model } } } });
/** 一条带用量的 assistant/message。 */
const message = (turn, step, time, usage) => ({ type: 'assistant/message', time, data: { turn, step, usage } });

/** 每桶各 100 万 token 的用量。 */
const ONE_MILLION_EACH = { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 };

/** 依次折叠一串事件。 */
function fold(events) {
  return events.reduce((state, event) => applyEvent(state, event), initState());
}

test('按事件自身的时刻计价：高峰与空闲各归各的', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    message(2, 1, OFF, ONE_MILLION_EACH),
  ]);
  const view = viewOf(state, 'CNY');
  // 高峰：hit .04 + miss 2 + out 8 = 10.04；空闲：.02 + 1 + 4 = 5.02
  assert.equal(view.peakCny, 10.04);
  assert.equal(view.offPeakCny, 5.02);
  assert.equal(view.totalCny, 15.06);
  assert.equal(view.pricedRequests, 2);
});

test('按当时的模型计价：中途换档不改写历史', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    route('deepseek-v4-pro'),
    message(2, 1, PEAK, ONE_MILLION_EACH),
  ]);
  // flash 高峰 10.04；pro 高峰 hit .3 + miss 9 + out 27 = 36.3
  assert.equal(viewOf(state, 'CNY').totalCny, 46.34);
});

test('同一 turn+step 后到替换先到（不是累加）', () => {
  const half = { inputTokens: 5e5, cacheReadTokens: 5e5, outputTokens: 5e5 };
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    message(1, 1, PEAK, half),
  ]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.totalCny, 5.02, '应只剩后到那一笔的一半金额');
  assert.equal(view.pricedRequests, 1, '替换不应增加请求计数');
});

test('llm/retry-started 之后的重试要累加（那是另一次真实计费调用）', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(2, 1, PEAK, ONE_MILLION_EACH),
    { type: 'llm/retry-started', time: PEAK, data: { turn: 2, step: 1 } },
    message(2, 1, PEAK, ONE_MILLION_EACH),
  ]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.totalCny, 20.08, '两次调用都要计费');
  assert.equal(view.pricedRequests, 2);
});

test('缓存写入单独成列，且按未命中单价计', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1e6, outputTokens: 0 }),
  ]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.writeCny, 2, '1M 写入 × 高峰 miss 价 2');
  assert.equal(view.missCny, 0, '未命中桶不应被写入污染');
  assert.equal(view.totalCny, 2);
});

test('没有路由信息时记为未计价，而不是按 0 价计', () => {
  const state = fold([message(1, 1, PEAK, ONE_MILLION_EACH)]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.pricedRequests, 0);
  assert.equal(view.unpricedRequests, 1);
  assert.equal(view.totalCny, 0);
});

test('视图金额保留 4 位小数', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    // 1 token 输出 → 8 / 1e6 = 0.000008，四舍五入到 4 位应为 0
    message(1, 1, PEAK, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ]);
  assert.equal(viewOf(state, 'CNY').missCny, 0);
  const state2 = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, { inputTokens: 1000, outputTokens: 0 }),
  ]);
  assert.equal(viewOf(state2, 'CNY').missCny, 0.002);
});
