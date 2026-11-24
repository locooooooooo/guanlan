import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileOpsModal } from '../components/FileOpsModal';
import { LeftSidebar } from '../components/LeftSidebar';
import type { AffectedReferenceItem } from '../hooks/useReferencePathRepair';
import type { FileRecord, ReadingState } from '../types/guanlan';

/**
 * C04 行为锁定（SSR 冒烟，与 commandPaletteView.test.ts 同风格）：
 * · FileOpsModal 升级面——可输入过滤的目标目录选择器常驻、隐藏当前所在目录
 *   （防成环）、受影响引用清单与确认制 checkbox（保存桥不可用时禁用）；
 * · LeftSidebar 智能视图区——五视图行 + 守恒计数徽标 + 清空/撤销结构。
 */

const noop = (): void => {};

function file(id: string, folder: string, format: FileRecord['format']): FileRecord {
  return {
    file_id: id,
    relative_path: folder === '.' ? `${id}.${format}` : `${folder}/${id}.${format}`,
    title: id,
    format,
    folder,
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: `rev_${id}`,
    revisions: [],
    coverage: 'full_text',
  };
}

function renderModal(
  overrides: Partial<Parameters<typeof FileOpsModal>[0]> = {},
  items: AffectedReferenceItem[] = []
): string {
  return renderToStaticMarkup(
    React.createElement(FileOpsModal, {
      request: {
        kind: 'move',
        fileId: 'f_svg',
        relativePath: '需求/提案/登录方案-架构.svg',
        title: '登录方案-架构',
        format: 'svg',
        revisionCount: 2,
        linkedDecisionCount: 1,
      },
      folderOptions: ['', '需求/提案', '交付/归档'],
      submitting: false,
      serverError: null,
      onClose: noop,
      onSubmit: noop,
      referenceImpact: { loading: false, items, saveAvailable: false },
      ...overrides,
    })
  );
}

test('FileOpsModal：目录选择器常驻过滤输入；隐藏当前所在目录（防成环）', () => {
  const html = renderModal();
  assert.ok(html.includes('aria-label="筛选已有目录"'), '过滤输入常驻（不再要求 >8 目录）');
  // 需求/提案 是被移动文件的当前所在目录 → 自动隐藏；根目录与交付/归档保留
  assert.ok(html.includes('交付/归档'));
  assert.ok(!html.includes('>需求/提案<'), '当前所在目录从可选列表隐藏（防成环）');
  assert.ok(html.includes('已隐藏当前所在目录'));
});

test('FileOpsModal：受影响引用清单 + 确认制 checkbox；保存桥不可用时禁用', () => {
  const items: AffectedReferenceItem[] = [
    {
      kind: 'markdown_link',
      sourceFileId: 'f_md',
      sourcePath: '需求/提案/登录方案.md',
      sourceTitle: '登录方案',
      line: 12,
      decisionCode: null,
      decisionQuestion: null,
    },
    {
      kind: 'decision_evidence',
      sourceFileId: 'f_svg',
      sourcePath: '需求/提案/登录方案-架构.svg',
      sourceTitle: 'SVG 架构图以何种布局承载登录网关？',
      line: 3,
      decisionCode: 'q01',
      decisionQuestion: 'SVG 架构图以何种布局承载登录网关？',
    },
  ];
  const html = renderModal({}, items);
  assert.ok(html.includes('data-reference-impact'), '引用影响区存在');
  assert.ok(html.includes('data-reference-impact-list'), '清单列表存在');
  assert.ok(html.includes('登录方案.md'), 'md 来源文档进清单');
  assert.ok(html.includes('决定证据'), '决定证据层标注');
  assert.ok(html.includes('data-reference-confirm-checkbox'), '确认制 checkbox 存在');
  assert.ok(html.includes('disabled'), '保存桥不可用 → checkbox 禁用（诚实口径）');
  assert.ok(html.includes('不会改写任何原文档'), '零改写承诺文案');
  // 无引用时整区不渲染
  const empty = renderModal({}, []);
  assert.ok(!empty.includes('data-reference-impact'), '无受影响引用 → 清单区不渲染');
});

function renderSidebar(
  overrides: Partial<Parameters<typeof LeftSidebar>[0]> = {}
): string {
  const files = [
    file('a', '需求', 'md'),
    file('b', '交付', 'svg'),
  ];
  const readingStates: Record<string, ReadingState> = {
    a: {
      file_id: 'a',
      last_read_revision_id: 'rev_old',
      scrollPercent: 10,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '2026-11-20T10:00:00+08:00',
    },
  };
  return renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      readingStates,
      totalCount: files.length,
      activeFileId: 'a',
      filters: {
        quickScope: 'all',
        folder: 'all',
        format: 'all',
        role: 'all',
        topic: 'all',
      },
      onUpdateFilters: noop,
      onResetFilters: noop,
      onOpenFileToRead: noop,
      ...overrides,
    })
  );
}

test('LeftSidebar：智能视图默认折叠让位目录树，激活态自动展开；清空/撤销结构按需出现', () => {
  const html = renderSidebar();
  assert.ok(html.includes('智能视图'), '智能视图折叠标题在位');
  assert.ok(!html.includes('data-smart-views'), '默认态智能视图折叠，不挤压下方目录树');
  assert.ok(!html.includes('data-clear-all-filters'), '无激活筛选 → 清空行不渲染');
  // 激活智能视图：自动展开胶囊区 + 清空行出现 + 该视图 aria-pressed
  const active = renderSidebar({
    filters: {
      quickScope: 'agent_drafts',
      folder: 'all',
      format: 'all',
      role: 'all',
      topic: 'all',
    },
  });
  assert.ok(active.includes('data-smart-views'), '激活智能视图时自动展开视图区');
  assert.ok(
    active.includes('data-smart-view="agent_drafts"'),
    '智能视图行携带视图 id'
  );
  assert.ok(active.includes('Agent 待审草案'), '当前激活智能视图可见');
  assert.ok(active.includes('data-clear-all-filters'), '激活筛选 → 清空全部筛选行出现');
  assert.ok(!active.includes('data-undo-clear-filters'), '未清空前撤销行不渲染');
});
