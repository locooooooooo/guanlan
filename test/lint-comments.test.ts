import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixText, killReason, lintText } from '../scripts/lint-comments.mjs';

function keeps(text: string, file = 'a.ts'): (string | null)[] {
  return lintText(text, file).map((block) => block.keep);
}

describe('注释门禁：TS 扫描不被字符串骗到', () => {
  it('单引号字符串与模板字面量里的双斜杠不算注释', () => {
    const text = [
      "const url = 'https://example.com//path';",
      'const t = `见 https://example.com // 说明 ${"// 仍在字符串里"} 尾部`;',
    ].join('\n');
    assert.deepEqual(lintText(text, 'a.ts'), []);
  });

  it('正则字面量里的转义斜杠不算注释', () => {
    assert.deepEqual(lintText('const re = /a\\/\\/b/g;', 'a.ts'), []);
  });
  it('JSX 文本里的双斜杠、块注释字面量与撇号不算注释，表达式内注释照常识别', () => {
    const text = [
      'export function Demo() {',
      '  return (',
      '    // 标签前注释',
      '    <details>',
      '      <summary>展开标准 Markdown 源码预览（带 guanlan:// 原文溯源链接）</summary>',
      "      <p>don't break /* literal */ // literal</p>",
      '      {/* 真正的 JSX 注释 */}',
      '      {(() => {',
      '        // 表达式里的注释',
      '        return <span>ok // text</span>;',
      '      })()}',
      '    </details>',
      '  );',
      '}',
    ].join('\n');
    const blocks = lintText(text, 'a.tsx');
    assert.equal(blocks.length, 3);
    const fixed = fixText(text, blocks, 'a.tsx');
    assert.ok(fixed.includes('guanlan:// 原文溯源链接）'));
    assert.ok(fixed.includes("don't break /* literal */ // literal"));
    assert.ok(fixed.includes('<span>ok // text</span>'));
    assert.ok(!fixed.includes('标签前注释'));
    assert.ok(!fixed.includes('真正的 JSX 注释'));
    assert.ok(!fixed.includes('表达式里的注释'));
  });
});

describe('注释门禁：TS 的留与删', () => {
  it('行注释与尾随注释都判删，整行注释连行删掉、尾随只收掉注释', () => {
    const text = ['const a = 1; // 尾随说明', '// 整行叙述', 'const b = 2;'].join('\n');
    assert.deepEqual(keeps(text), [null, null]);
    assert.equal(fixText(text, lintText(text, 'a.ts')), 'const a = 1;\nconst b = 2;');
  });

  it('JSDoc 只在导出声明前算公开 API 契约', () => {
    const text = ['/** 导出契约 */', 'export function f() {}', '/** 私有实现说明 */', 'function g() {}'].join('\n');
    assert.deepEqual(keeps(text), ['doc', null]);
  });

  it('许可头、prettier-ignore、Issue 链接留下', () => {
    assert.deepEqual(keeps('// Copyright 2026 观澜\nconst a = 1;'), ['license']);
    assert.deepEqual(keeps('// prettier-ignore\nconst a = 1;'), ['prettier']);
    assert.deepEqual(keeps('// 见 https://github.com/x/y/issues/12\nconst a = 1;'), ['reference']);
  });

  it('lint 抑制判删并单列原因', () => {
    const blocks = lintText('// eslint-disable-next-line react-hooks/exhaustive-deps -- 说明', 'a.ts');
    assert.deepEqual(blocks.map((block) => block.keep), [null]);
    assert.equal(killReason(blocks[0]), 'lint 抑制');
  });

  it('横幅分隔与被注释掉的代码各自归因', () => {
    const banner = lintText('// ================= 几何原语 =================', 'a.ts');
    const corpse = lintText('// const legacy = buildOldTable();', 'a.ts');
    assert.equal(killReason(banner[0]), '横幅分隔');
    assert.equal(killReason(corpse[0]), '被注释掉的代码');
  });

  it('块注释跨行时整段删除，代码保留', () => {
    const text = ['const a = 1;', '/* 第一行', '   第二行 */', 'const b = 2;'].join('\n');
    assert.equal(fixText(text, lintText(text, 'a.ts')), 'const a = 1;\nconst b = 2;');
  });

  it('JSX 注释容器连花括号一起删，不留 { } 空容器', () => {
    const text = ['<div>', '  {/* 说明 */}', '  <span>{/* 行内 */}</span>', '  { /* 带空格 */ }', '  <b>x</b>', '</div>'].join(
      '\n',
    );
    assert.equal(
      fixText(text, lintText(text, 'a.tsx'), 'a.tsx'),
      ['<div>', '  <span></span>', '  <b>x</b>', '</div>'].join('\n'),
    );
  });
});

describe('注释门禁：Rust 扫描不被字符串与生命周期骗到', () => {
  it('原生字符串、字符字面量与生命周期里的斜杠不算注释', () => {
    const text = [
      'const RAW: &str = r#"// 不是注释 /* 也不是 */"#;',
      "const SLASH: char = '/';",
      "fn borrow<'a>(x: &'a str) -> &'a str { x }",
    ].join('\n');
    assert.deepEqual(lintText(text, 'a.rs'), []);
  });

  it('嵌套块注释整体算一条并整段删除', () => {
    const text = '/* 外层 /* 内层 */ 仍在外层 */\nconst A: u8 = 1;';
    const blocks = lintText(text, 'a.rs');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].body, '/* 外层 /* 内层 */ 仍在外层 */');
    assert.equal(fixText(text, blocks), 'const A: u8 = 1;');
  });

  it('连续多行 /// 按整块判定：pub 项前留下，私有项前删掉', () => {
    const text = ['/// 第一行', '/// 第二行', 'pub fn open() {}', '/// 私有说明', 'fn hidden() {}'].join('\n');
    assert.deepEqual(keeps(text, 'a.rs'), ['doc', 'doc', null]);
  });

  it('//! 模块契约与 SAFETY 注释留下，裸叙述删掉', () => {
    const text = ['//! 模块契约', '// SAFETY: FFI 调用方保证指针非空', '// 叙述'].join('\n');
    assert.deepEqual(keeps(text, 'a.rs'), ['doc', 'safety', null]);
  });

  it('带属性的 pub 项也是公开契约', () => {
    const text = ['/// 契约', '#[inline]', 'pub const LIMIT: usize = 8;'].join('\n');
    assert.deepEqual(keeps(text, 'a.rs'), ['doc']);
  });
});

describe('注释门禁：删除是幂等的', () => {
  it('同一份源码连跑两次结果不变', () => {
    const text = [
      '// 头部叙述',
      'export const a = 1; // 尾随',
      '/* 块',
      '   注释 */',
      '/// 私有',
      'fn hidden() {}',
    ].join('\n');
    const once = fixText(text, lintText(text, 'a.rs'));
    const twice = fixText(once, lintText(once, 'a.rs'));
    assert.equal(twice, once);
  });
});
