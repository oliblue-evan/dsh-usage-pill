/**
 * 计价内核（宿主半侧，纯函数、零依赖）。
 *
 * 【为什么宿主也要有一份价目表】
 *   费用要**按每一笔用量实际发生的时刻和模型**计价，才不会被历史追溯改写
 *   （跨过峰谷边界、或中途换了模型）。而 provider 上报的 usage 是逐条事件，
 *   所以折叠必须发生在宿主；浏览器半边拿不到逐条事件。
 *
 * 【与 client.js 的关系】
 *   client.js 里还有一份同样的表 —— 它用于**展示"当前单价"**（那是此刻的价，
 *   本来就该按浏览器的时间算）。两份表由 test/pricing-parity.test.mjs 逐字段
 *   比对，防止改一边忘另一边。
 *
 * 【口径来源】
 *   官方定价页 https://api-docs.deepseek.com/quick_start/pricing ；
 *   高峰 = 北京时间周一至周五 09:00–12:00 与 14:00–18:00（左闭右开），
 *   周末与法定节假日整天按空闲计价。缓存写入按"未命中"单价计。
 */

/** 北京时间 = UTC+8。 */
const BJ_OFFSET_MS = 8 * 3600e3;

/** 高峰窗口（北京时间当天第几分钟，左闭右开）。 */
export const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

/**
 * 中国法定节假日（北京时间日期）——官方把节假日整天算空闲。
 * 【维护点】按年扩表（依据国办发明电〔2025〕7 号）。
 */
export const CN_STATUTORY_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);

/**
 * 价格政策时间线：每档给出生效时刻与空闲单价（元 / 百万 tokens）。
 * `peakMultiplier` 为 1 表示该档不分峰谷。
 * 【维护点】官方调价时在对应档位追加一条 `{ from: Date.UTC(...), ... }`。
 */
export const PRICE_SCHEDULES = {
  flash: [
    { from: 0, hit: 0.02, miss: 1, out: 2, peakMultiplier: 1 },
    { from: Date.UTC(2026, 7, 16, 16, 0, 0), hit: 0.05, miss: 1.5, out: 4.5, peakMultiplier: 2 },
    { from: Date.UTC(2026, 8, 10, 4, 0, 0), hit: 0.02, miss: 1, out: 4, peakMultiplier: 2 },
  ],
  pro: [
    { from: 0, hit: 0.025, miss: 3, out: 6, peakMultiplier: 1 },
    { from: Date.UTC(2026, 7, 16, 16, 0, 0), hit: 0.15, miss: 4.5, out: 13.5, peakMultiplier: 2 },
  ],
};

/** 北京时间当天日期串（YYYY-MM-DD）。 */
function beijingDate(timeMs) {
  return new Date(timeMs + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 该时刻是否处于高峰。
 * @param timeMs - UTC 毫秒。
 * @returns 高峰 true；周末、法定节假日、窗口外 false。
 */
export function isPeakAt(timeMs) {
  if (!Number.isFinite(timeMs)) return false;
  if (CN_STATUTORY_HOLIDAYS.has(beijingDate(timeMs))) return false;
  const shifted = new Date(timeMs + BJ_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/** 模型名 → 价目档位：含 flash 走 flash 档，其余走 pro 档。 */
export function tierOfModel(model) {
  return String(model || '').toLowerCase().includes('flash') ? 'flash' : 'pro';
}

/**
 * 某模型在某时刻的单价（元 / 百万 tokens）。
 * @param model - 模型 id。
 * @param timeMs - 用量发生时刻。
 * @returns `{ tier, regime, flat, multiplier, hit, miss, out }`。
 */
export function rateAt(model, timeMs) {
  const tier = tierOfModel(model);
  const schedules = PRICE_SCHEDULES[tier];
  let chosen = schedules[0];
  for (const schedule of schedules) {
    if (schedule.from <= timeMs) chosen = schedule;
  }
  const flat = chosen.peakMultiplier === 1;
  const peak = !flat && isPeakAt(timeMs);
  const multiplier = peak ? chosen.peakMultiplier : 1;
  return {
    tier,
    regime: flat ? 'flat' : (peak ? 'peak' : 'off'),
    flat,
    multiplier,
    hit: chosen.hit * multiplier,
    miss: chosen.miss * multiplier,
    out: chosen.out * multiplier,
  };
}

/**
 * provider 上报的 usage → 四个计费桶。
 * @param usage - `TokenUsage`。
 * @returns `{ input, cacheRead, cacheWrite, output }`。
 */
export function bucketsFromUsage(usage) {
  return {
    input: Number(usage && usage.inputTokens) || 0,
    cacheRead: Number(usage && usage.cacheReadTokens) || 0,
    cacheWrite: Number(usage && usage.cacheWriteTokens) || 0,
    output: Number(usage && usage.outputTokens) || 0,
  };
}

/**
 * 按一组桶与一个价目给一笔用量计价（元）。缓存写入按未命中单价计。
 * @param buckets - {@link bucketsFromUsage} 的结果。
 * @param rate - {@link rateAt} 的结果。
 * @returns `{ hit, miss, out, total, regime }`。
 */
export function costOfBuckets(buckets, rate) {
  const hit = (buckets.cacheRead * rate.hit) / 1e6;
  const miss = ((buckets.input + buckets.cacheWrite) * rate.miss) / 1e6;
  const out = (buckets.output * rate.out) / 1e6;
  return { hit, miss, out, total: hit + miss + out, regime: rate.regime };
}

/**
 * 取一条事件里 provider 上报的 usage。
 *
 * `assistant/message` 优先用 `data.usage`；否则（含 `assistant/attempt`）在
 * `data.stream` 里从后往前找最后一个 `usage` chunk。
 *
 * @param event - 一条会话事件。
 * @returns usage，或 undefined。
 */
export function usageOfEvent(event) {
  if (!event || !event.data) return undefined;
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = event.data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
      return record.chunk.usage;
    }
  }
  return undefined;
}
