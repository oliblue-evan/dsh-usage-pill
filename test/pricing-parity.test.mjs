/**
 * 防漂移门禁：宿主与客户端的价目表必须逐字段一致。
 *
 * 为什么会有两份：宿主用它**逐笔计价**（需要知道"那一笔发生时的价"），
 * 客户端用它**展示"当前单价"**（需要按浏览器此刻的价）。职责不同，但数据必须同源，
 * 否则会出现"面板说 ¥4/M，账单按别的价算"这种最难查的偏差。
 *
 * 改价时两边都要改 —— 这个测试就是防止只改一边。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CN_STATUTORY_HOLIDAYS as HOST_HOLIDAYS, PEAK_WINDOWS as HOST_WINDOWS, PRICE_SCHEDULES as HOST_SCHEDULES } from '../lib/pricing.js';
import { clientScope } from './extract-client.mjs';

const client = clientScope(['PRICE_SCHEDULES', 'CN_STATUTORY_HOLIDAYS', 'PEAK_WINDOWS', 'BJ_OFFSET_MS']);

test('宿主与客户端的价目表逐字段一致', () => {
  assert.deepEqual(client.PRICE_SCHEDULES, HOST_SCHEDULES,
    'lib/pricing.js 与 client.js 的价目表已漂移 —— 官方调价时两边都要改');
});

test('法定节假日表一致', () => {
  assert.deepEqual([...client.CN_STATUTORY_HOLIDAYS].sort(), [...HOST_HOLIDAYS].sort(),
    '节假日表已漂移');
});

test('高峰窗口与时区偏移一致', () => {
  assert.deepEqual(client.PEAK_WINDOWS, HOST_WINDOWS);
  assert.equal(client.BJ_OFFSET_MS, 8 * 3600e3);
});
