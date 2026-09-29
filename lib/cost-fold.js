/**
 * `usagePillCost` 投影的**纯折叠逻辑**（零依赖之外的唯一 import 是计价内核）。
 *
 * 与 `cost-projection.js` 分开是有意的：那边只负责 zod schema 与注册接线，
 * 这边是纯粹的 state → state 折叠，可以在 workspace 里直接 import 单测
 * （zod 在 DSH 的 asar 里，普通 node 进程解析不到）。
 *
 * 折叠口径：
 *   · `request/header` 记录当前路由（provider/model），供后续用量取价；
 *   · `assistant/message` / `assistant/attempt` 携带用量，按其**自身时刻**计价；
 *   · 同一 turn+step 后到的**替换**先到的（重发一次 = 改一次金额，不叠加）；
 *   · `llm/retry-started` 关闭替换槽，让重试**累加**（那是另一次真实计费调用）。
 */

import { bucketsFromUsage, costOfBuckets, rateAt, usageOfEvent } from './pricing.js';

/** 金额保留 4 位小数。 */
export const round = (value) => Math.round(value * 1e4) / 1e4;

/** 零金额。 */
export function zeroMoney() {
  return { cacheReadCny: 0, missCny: 0, writeCny: 0, outputCny: 0, peakCny: 0, offPeakCny: 0 };
}

/** 零累计。 */
export function zeroTotals() {
  return { ...zeroMoney(), pricedRequests: 0, unpricedRequests: 0 };
}

/** 初始折叠状态。 */
export function initState() {
  return { route: null, totals: zeroTotals(), last: null };
}

/**
 * 把一份样本加进（或从）累计里。
 * @param totals - 当前累计。
 * @param sample - 样本。
 * @param direction - 1 加入，-1 移除。
 * @returns 调整后的累计。
 */
export function adjustTotals(totals, sample, direction) {
  return {
    cacheReadCny: totals.cacheReadCny + direction * sample.cacheReadCny,
    missCny: totals.missCny + direction * sample.missCny,
    writeCny: totals.writeCny + direction * sample.writeCny,
    outputCny: totals.outputCny + direction * sample.outputCny,
    peakCny: totals.peakCny + direction * sample.peakCny,
    offPeakCny: totals.offPeakCny + direction * sample.offPeakCny,
    pricedRequests: totals.pricedRequests + direction * (sample.priced ? 1 : 0),
    unpricedRequests: totals.unpricedRequests + direction * (sample.priced ? 0 : 1),
  };
}

/**
 * 给一笔用量定价。
 * @param route - 当时的 provider/model。
 * @param usage - provider 上报的用量。
 * @param time - 事件时刻（UTC 毫秒）。
 * @returns 已定价样本。
 */
export function sampleFor(route, usage, time) {
  const rate = rateAt(route.model, time);
  const buckets = bucketsFromUsage(usage);
  const cost = costOfBuckets(buckets, rate);
  // costOfBuckets 把"缓存写入"并进了未命中价，这里拆开，便于界面逐行显示
  const writeCny = (buckets.cacheWrite * rate.miss) / 1e6;
  const peak = rate.regime === 'peak';
  return {
    cacheReadCny: cost.hit,
    missCny: cost.miss - writeCny,
    writeCny,
    outputCny: cost.out,
    peakCny: peak ? cost.total : 0,
    offPeakCny: peak ? 0 : cost.total,
    priced: true,
  };
}

/**
 * 折叠一条事件。
 * @param state - 当前状态。
 * @param event - 一条会话事件。
 * @returns 下一个状态。
 */
export function applyEvent(state, event) {
  if (event.type === 'request/header') {
    const call = event.data && event.data.header ? event.data.header.config : undefined;
    if (call === undefined) return state;
    return { ...state, route: { provider: call.provider, model: call.model } };
  }
  if (event.type === 'llm/retry-started') {
    return state.last !== null && state.last.turn === event.data.turn && state.last.step === event.data.step
      ? { ...state, last: null }
      : state;
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;

  const { turn, step } = event.data;
  const usage = usageOfEvent(event);
  if (usage === undefined) return state;

  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last.sample
    : undefined;
  const sample = state.route === null
    ? { ...zeroMoney(), priced: false }
    : sampleFor(state.route, usage, event.time);
  const base = previous === undefined ? state.totals : adjustTotals(state.totals, previous, -1);
  return { ...state, totals: adjustTotals(base, sample, 1), last: { turn, step, sample } };
}

/**
 * 折叠状态 → 线上视图（浏览器读到的形状）。
 * @param state - 折叠状态。
 * @param currency - 计价货币。
 * @returns 视图对象。
 */
export function viewOf(state, currency) {
  const totals = state.totals;
  return {
    currency,
    cacheReadCny: round(totals.cacheReadCny),
    missCny: round(totals.missCny),
    writeCny: round(totals.writeCny),
    outputCny: round(totals.outputCny),
    totalCny: round(totals.cacheReadCny + totals.missCny + totals.writeCny + totals.outputCny),
    peakCny: round(totals.peakCny),
    offPeakCny: round(totals.offPeakCny),
    pricedRequests: totals.pricedRequests,
    unpricedRequests: totals.unpricedRequests,
  };
}
