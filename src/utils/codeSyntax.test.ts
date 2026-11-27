import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeFoldableRanges,
  extractCodeSymbols,
  findCodeMatches,
  resolveCodeLanguage,
  tokenizeCodeLines,
} from './codeSyntax';
import { NonLegacyFilePreviewPanel } from '../components/NonLegacyFilePreviewPanel';
import type { FileRecord, Revision } from '../types/guanlan';

test('codeSyntax：按格式解析语言、词法高亮（含跨行块注释）与符号抽取', () => {
  assert.equal(resolveCodeLanguage('rs'), 'rust');
  assert.equal(resolveCodeLanguage('tsx'), 'ts');
  assert.equal(resolveCodeLanguage('py'), 'python');
  assert.equal(resolveCodeLanguage('txt'), 'plain');

  const rsSource = [
    '/* multi-line',
    '   comment */',
    'pub struct Bootstrap {',
    '    count: usize,',
    '}',
    'pub fn run_bootstrap(name: &str) -> Result<(), String> {',
    '    let msg = "ok"; // inline note',
    '    Ok(())',
    '}',
  ].join('\n');

  const lines = tokenizeCodeLines(rsSource, 'rs');
  assert.equal(lines.length, 9);
  assert.equal(lines[0].tokens[0].kind, 'comment');
  assert.equal(lines[1].tokens[0].kind, 'comment');
  assert.ok(lines[5].tokens.some((t) => t.kind === 'keyword' && t.text === 'fn'));
  assert.ok(lines[5].tokens.some((t) => t.kind === 'type' && t.text === 'Result'));
  assert.ok(lines[6].tokens.some((t) => t.kind === 'string' && t.text === '"ok"'));
  assert.ok(lines[6].tokens.some((t) => t.kind === 'comment' && t.text === '// inline note'));

  const symbols = extractCodeSymbols(rsSource, 'rs');
  assert.deepEqual(
    symbols.map((s) => `${s.kind}:${s.name}@${s.line}`),
    ['struct:Bootstrap@3', 'fn:run_bootstrap@6']
  );

  const folds = computeFoldableRanges(rsSource, 'rs');
  assert.equal(folds.get(3), 5, '3 行结构体块可折叠');
  assert.equal(folds.get(6), 9, '4 行函数块可折叠');

  const hits = findCodeMatches(rsSource.split('\n'), 'bootstrap');
  assert.deepEqual(
    hits.map((h) => h.line),
    [3, 6]
  );
});

test('NonLegacyFilePreviewPanel（代码阅读器）：语法高亮、行号槽、折叠/大纲/查找、宽版与引用锚点', () => {
  const codeText = [
    'pub struct Engine {',
    '    pub port: u16,',
    '}',
    '',
    'pub fn handle_request() -> bool {',
    '    let ready = true;',
    '    ready',
    '}',
  ].join('\n');

  const rev: Revision = {
    revision_id: 'rev_rs_code',
    file_id: 'f_rs_code',
    versionNumber: 2,
    content_sha256: '1234abcd'.repeat(8),
    observed_at: '2026-11-24T10:00:00Z',
    sizeBytes: 2560,
    snapshotAvailable: true,
    isBaselineProtected: false,
    summaryNote: 'v2',
    markdownContent: codeText,
  };
  const rsFile: FileRecord = {
    file_id: 'f_rs_code',
    relative_path: 'native/crates/guanlan-core/src/lib.rs',
    title: 'lib.rs',
    format: 'rs',
    folder: 'native/crates/guanlan-core/src',
    role: '其他',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: rev.revision_id,
    revisions: [rev],
    coverage: 'full_text',
  };

  const rsHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: rsFile,
      currentRev: rev,
      paperLightMode: true,
      indexGeneration: 1,
      sourceLine: 6,
    })
  );

  assert.ok(rsHtml.includes('data-code-wide-mode="full"'), '工程源码默认启用宽版布局');
  assert.ok(rsHtml.includes('data-token-kind="keyword"'), '源码具备词法高亮 token');
  assert.ok(rsHtml.includes('data-code-line-number="6"'), '源码区呈现完整行号槽');
  assert.ok(rsHtml.includes('data-code-outline-toggle=""'), '存在符号时渲染大纲开关');
  assert.ok(rsHtml.includes('大纲 (2)'), '符号大纲计数与抽取结果一致');
  assert.ok(rsHtml.includes('data-code-find-toggle=""'), '提供页内查找入口');
  assert.ok(rsHtml.includes('data-code-fold-toggle="1"'), '可折叠代码块带折叠按钮');
  assert.ok(
    rsHtml.includes('data-code-anchor-line="6"') &&
      rsHtml.includes('data-anchor-highlight="true"') &&
      rsHtml.includes('引用锚点'),
    '跳转指定行使用统一引用锚点样式并标明「引用锚点」'
  );

  const txtFile: FileRecord = {
    ...rsFile,
    file_id: 'f_txt_plain',
    relative_path: 'notes/readme.txt',
    title: 'readme.txt',
    format: 'txt',
    folder: 'notes',
  };
  const txtHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: txtFile,
      currentRev: { ...rev, file_id: 'f_txt_plain', markdownContent: 'hello world\nline 2' },
      paperLightMode: true,
      indexGeneration: 1,
    })
  );
  assert.ok(txtHtml.includes('data-code-wide-mode="contained"'), '纯文本默认保持舒适居中行宽');
  assert.ok(!txtHtml.includes('data-code-outline-toggle=""'), '无结构符号时不渲染空大纲按钮');
});
