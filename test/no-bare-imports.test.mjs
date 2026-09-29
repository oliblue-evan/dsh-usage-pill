/**
 * 回归门禁：宿主半边**不得出现裸模块名**。
 *
 * 为什么这条值得一个测试：宿主插件的裸模块名按插件的**真实路径**解析，而本插件是
 * `link:` 安装的（真实路径在工作区），profile 的 `autoInstallPeers` 又是关闭的 ——
 * 一旦某个裸模块解析不到，`import` 会在模块加载期抛出，**整个宿主半边起不来**
 * （注意：这不是降级，是硬失败）。相对路径 import 才是安全的。
 *
 * 这个坑我在引入 zod 时踩过一次（`whale-girl-pet` 也把 zod 放在 peer 里，
 * 它当年是否真的加载成功其实无从确认）。现在用测试把它钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOST_FILES = ['index.js', 'lib/pricing.js', 'lib/cost-fold.js', 'lib/cost-projection.js', 'lib/schema.js'];

test('宿主半边只使用相对路径 import', () => {
  for (const file of HOST_FILES) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*?['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('.'), file + ' 引入了裸模块名 "' + specifier + '"，link: 安装下会解析不到');
    }
  }
});

test('宿主半边不使用 import() 动态裸模块', () => {
  for (const file of HOST_FILES) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.'), file + ' 动态引入了裸模块名 "' + match[1] + '"');
    }
  }
});

test('宿主半边不再引用 zod', () => {
  for (const file of HOST_FILES) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.ok(!/\bzod\b/.test(source.replace(/\/\*\*[\s\S]*?\*\//g, '')), file + ' 仍引用 zod');
  }
});
