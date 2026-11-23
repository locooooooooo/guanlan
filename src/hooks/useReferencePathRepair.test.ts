import test from 'node:test';
import assert from 'node:assert/strict';
import { isMoveBlockedBySelfDrag } from './useSidebarTreeDrag';
import { relativeHrefFromDir, rewriteMarkdownReferences } from './useReferencePathRepair';

/**
 * C04 行为锁定：树内拖拽防成环纯函数 + Markdown 引用路径改写纯函数
 * （任务卡 §5 C04：拖向自身 100% 拦截防成环；引用修复严格确认制、锚点/语法保真）。
 */

test('isMoveBlockedBySelfDrag：拖回当前所在目录 100% 拦截（大小写无关）', () => {
  assert.equal(isMoveBlockedBySelfDrag('需求/提案', '需求/提案'), true);
  assert.equal(isMoveBlockedBySelfDrag('', ''), true); // 根目录拖回根
  assert.equal(isMoveBlockedBySelfDrag('需求/提案', ''), false);
  assert.equal(isMoveBlockedBySelfDrag('', '需求/提案'), false);
  assert.equal(isMoveBlockedBySelfDrag(null, '需求/提案'), false); // 非拖拽中
  // Windows 大小写无关（盘符根工作区口径）
  assert.equal(isMoveBlockedBySelfDrag('Docs/Spec', 'docs/spec'), true);
  assert.equal(isMoveBlockedBySelfDrag('C:\\Docs', 'C:/Docs'), true);
  // 反斜杠归一
  assert.equal(isMoveBlockedBySelfDrag('需求\\提案', '需求/提案'), true);
});

test('relativeHrefFromDir：相对路径语义与 documentLinks.resolve 互逆', () => {
  // 同目录
  assert.equal(relativeHrefFromDir('需求/提案', '需求/提案/登录方案-架构.svg'), '登录方案-架构.svg');
  // 下钻
  assert.equal(relativeHrefFromDir('', '设计/图纸/图.svg'), '设计/图纸/图.svg');
  // 上跳
  assert.equal(relativeHrefFromDir('需求/提案', '设计/图.svg'), '../../设计/图.svg');
  // 根源文档
  assert.equal(relativeHrefFromDir('', '交付/清单/验收.docx'), '交付/清单/验收.docx');
  // 公共前缀
  assert.equal(relativeHrefFromDir('需求/提案', '需求/提案/子/图.svg'), '子/图.svg');
  // 空格转义（裸 href 语法不允许空格）
  assert.equal(relativeHrefFromDir('', '我的 文件/图.pdf'), '我的%20文件/图.pdf');
});

test('rewriteMarkdownReferences：行内 Markdown 链接精确替换（锚点/标题/<>保真）', () => {
  const source = '需求/提案/登录方案.md';
  const content = [
    '架构见 [架构图](登录方案-架构.svg) 与 [登录](./登录网关.md)。',
    '页码证据：[审计页](../../证据/审计报告.pdf#page=3 "标题不变")。',
    '尖括号：[空格路径](<../../证据/我的 报告.docx>)。',
    'code span：`证据/审计报告.pdf#page=2`。',
    '无关链接：[别的](别的.md) 不动。',
  ].join('\n');
  const rewritten = rewriteMarkdownReferences(content, source, '证据/审计报告.pdf', '交付/归档/审计报告.pdf');
  assert.equal(rewritten.changed, 2); // 页码证据链接 + code span
  const lines = rewritten.text.split('\n');
  assert.equal(lines[0], '架构见 [架构图](登录方案-架构.svg) 与 [登录](./登录网关.md)。');
  assert.equal(
    lines[1],
    '页码证据：[审计页](../../交付/归档/审计报告.pdf#page=3 "标题不变")。'
  );
  assert.equal(lines[2], '尖括号：[空格路径](<../../证据/我的 报告.docx>)。');
  assert.equal(lines[3], 'code span：`../../交付/归档/审计报告.pdf#page=2`。');
  assert.equal(lines[4], '无关链接：[别的](别的.md) 不动。');
});

test('rewriteMarkdownReferences：同目录移动后 ../ 降为裸名；多次命中同一行全量替换', () => {
  const source = '需求/提案/登录方案.md';
  const content = '对比 [甲](登录方案-架构.svg) 与 [乙](登录方案-验收.docx#para=1)。';
  const rewritten = rewriteMarkdownReferences(
    content,
    source,
    '需求/提案/登录方案-架构.svg',
    '需求/提案/子目录/登录方案-架构.svg'
  );
  assert.equal(rewritten.changed, 1);
  assert.ok(rewritten.text.includes('[甲](子目录/登录方案-架构.svg)'));
  assert.ok(rewritten.text.includes('[乙](登录方案-验收.docx#para=1)'));
});

test('rewriteMarkdownReferences：不命中旧路径的 href 零改写（取消/无关零字节）', () => {
  const content = '[图](别的.svg) 与 [正](./登录方案-架构.svg)。';
  const rewritten = rewriteMarkdownReferences(content, 'a/b.md', '证据/审计.pdf', 'x/审计.pdf');
  assert.equal(rewritten.changed, 0);
  assert.equal(rewritten.text, content);
});
