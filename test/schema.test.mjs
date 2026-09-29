/**
 * 自带校验器的断言。
 *
 * 它替代了 zod，所以必须证明两件事：合法数据放行、非法数据**抛错**（不静默兜底）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bool, count, nonNeg, nullableOf, num, object, str, strLen } from '../lib/schema.js';

test('基本类型：合法放行', () => {
  assert.equal(num().parse(1.5), 1.5);
  assert.equal(nonNeg().parse(0), 0);
  assert.equal(count().parse(3), 3);
  assert.equal(str().parse('a'), 'a');
  assert.equal(strLen(3).parse('CNY'), 'CNY');
  assert.equal(bool().parse(false), false);
  assert.equal(nullableOf(num()).parse(null), null);
  assert.equal(nullableOf(num()).parse(2), 2);
});

test('基本类型：非法一律抛错', () => {
  assert.throws(() => num().parse('1'), TypeError, '字符串不是数字');
  assert.throws(() => num().parse(Number.NaN), TypeError);
  assert.throws(() => num().parse(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => nonNeg().parse(-1), TypeError, '金额不能为负');
  assert.throws(() => count().parse(1.5), TypeError, '计数必须是整数');
  assert.throws(() => count().parse(-1), TypeError);
  assert.throws(() => strLen(3).parse('CN'), TypeError);
  assert.throws(() => nullableOf(num()).parse(undefined), TypeError, 'undefined 不是 null');
});

test('严格对象：未声明字段被拒绝，且返回只含声明字段的新对象', () => {
  const schema = object({ a: num(), b: str() });
  assert.deepEqual(schema.parse({ a: 1, b: 'x' }), { a: 1, b: 'x' });
  assert.throws(() => schema.parse({ a: 1, b: 'x', c: 2 }), /未声明的字段/, '多出字段要拒绝（等价 zod strict）');
  assert.throws(() => schema.parse(null), TypeError);
  assert.throws(() => schema.parse([1, 2]), TypeError, '数组不是对象');
  // 返回的是新对象，不是入参
  const input = { a: 1, b: 'x' };
  assert.notEqual(schema.parse(input), input);
});

test('嵌套对象：报错信息带得出字段路径', () => {
  const schema = object({ outer: object({ inner: nonNeg() }) });
  assert.throws(() => schema.parse({ outer: { inner: -1 } }), /outer\.inner/, '错误里应有路径便于定位');
});
