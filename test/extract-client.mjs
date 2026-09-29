/**
 * 从浏览器 bundle 里取出"纯逻辑"作用域。
 *
 * `client.js` 是给 `window.__ModuleLoader__` 的工厂产物，而且是**单文件**（宿主把各插件
 * bundle 拼成 combo 脚本、以传统脚本执行，relative ESM import 不成立），所以不能在 node
 * 里 import。这里按 `client.js` 里显式的 `#region 纯逻辑` / `#endregion 纯逻辑` 标记抽取
 * 那一段求值 —— 那段只有纯函数，不含 React/DOM。
 *
 * 标记缺失或重复都会立刻抛错，不会静默取到半截（`test/structure.test.mjs` 另有断言）。
 *
 * @param names - 需要取出的符号名。
 * @returns 由这些符号组成的对象。
 */
import { readFileSync } from 'node:fs';

/** 读取 client.js（统一换行，避免 CRLF 干扰标记匹配）。 */
export function clientSource() {
  return readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/** 抽出纯逻辑区块的源码。 */
export function pureLogicBlock() {
  const source = clientSource();
  const START = '// #region 纯逻辑';
  const END = '// #endregion 纯逻辑';
  const startCount = source.split(START).length - 1;
  const endCount = source.split(END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`client.js 的纯逻辑 region 标记应各出现 1 次，实际 ${startCount}/${endCount}`);
  }
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (end <= start) throw new Error('client.js 的纯逻辑 region 顺序不对');
  return source.slice(start, end);
}

/**
 * 求值纯逻辑区块并取出指定符号。
 * @param names - 需要取出的符号名。
 * @returns 由这些符号组成的对象。
 */
export function clientScope(names) {
  return new Function(pureLogicBlock() + '\n return { ' + names.join(', ') + ' };')();
}
