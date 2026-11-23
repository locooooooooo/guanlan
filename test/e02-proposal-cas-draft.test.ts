/**
 * E02 · 外部智能体文件写入 CAS 安全网、独立草案分支（v(N+1)-agent-draft）与
 * 「查看多模态 Diff → 采纳落盘 / 退回重做」前端纯函数与 SSR 渲染契约测试。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ProposalToast, {
  proposalToastTitle,
  shortContextHash,
  summarizeProposalMultimodalDiff,
  type ProposalToastData,
} from '../src/components/ProposalToast';
import type { RevisionProposalContentResponse } from '../src/services/apiTypes';

function makeDraftContent(
  overrides: Partial<RevisionProposalContentResponse> = {}
): RevisionProposalContentResponse {
  return {
    ok: true,
    index_generation: 12,
    draft_id: 'draft_e02_1',
    file_id: 'f_plan',
    path: '01-演示专项/02-实施计划.md',
    format: 'md',
    draft_version_label: 'v3-agent-draft',
    base_revision_id: 'rev_2',
    base_content_hash: 'a'.repeat(64),
    disk_content_hash: 'a'.repeat(64),
    proposed_content_hash: 'b'.repeat(64),
    source: 'agent',
    status: 'proposed',
    conflict: false,
    note: null,
    receipt_summary: '依据上游架构规范补全 CAS 守卫与回滚步骤',
    input_context_hashes: ['sha256:0123456789abcdef', 'fedcba9876543210'],
    base_text: '# 实施计划\n- [ ] 实现回写\n[P1 - 待确认] 是否保留备份\n决定：___\n',
    disk_text: '# 实施计划\n- [ ] 实现回写\n[P1 - 待确认] 是否保留备份\n决定：___\n',
    proposed_text:
      '# 实施计划\n- [x] 实现回写\n- [ ] 补齐 CAS 冲突保护\n[P1 - 已确认] 是否保留备份\n决定：保留私有快照备份\n',
    truncated: false,
    created_at: '2026-11-21T14:00:00Z',
    ...overrides,
  };
}

describe('E02 ProposalToast 独立草案分支与多模态 Diff 摘要', () => {
  test('草案标题正确展示 v(N+1)-agent-draft 分支标签与短哈希芯片', () => {
    assert.equal(
      proposalToastTitle({ fileName: '02-实施计划.md', versionLabel: 'v3-agent-draft' }),
      '智能体已提交《02-实施计划.md》修订草案（v3-agent-draft）'
    );
    assert.equal(shortContextHash('sha256:0123456789abcdef9999'), '0123456789ab');
    assert.equal(shortContextHash('  fedcba9876543210  '), 'fedcba987654');
  });

  test('无冲突 Markdown 草案：走基准版↔草案分支，产出决策/待办/行级多模态亮点', () => {
    const summary = summarizeProposalMultimodalDiff(makeDraftContent());
    assert.equal(summary.modeLabel, 'Markdown 语义 Diff');
    assert.equal(summary.compareLabel, '基准版 ↔ 草案分支');
    assert.ok(summary.addedCount >= 2);
    assert.ok(summary.removedCount >= 1);
    assert.ok(summary.highlights.some((h) => h.includes('待办清单变化')));
    assert.ok(summary.lines.some((l) => l.kind === 'added' && l.text.includes('CAS 冲突保护')));
  });

  test('并发冲突 Markdown 草案：强制以磁盘现态作为左栏基线，绝不隐藏人工未保存修改', () => {
    const humanEdit = '# 实施计划\n人工刚刚补充的红线条款\n- [ ] 实现回写\n';
    const summary = summarizeProposalMultimodalDiff(
      makeDraftContent({
        conflict: true,
        disk_content_hash: 'c'.repeat(64),
        disk_text: humanEdit,
      })
    );
    assert.equal(summary.compareLabel, '磁盘现态 ↔ 草案分支（冲突比对）');
    assert.ok(
      summary.lines.some((l) => l.kind === 'removed' && l.text.includes('人工刚刚补充的红线条款')),
      '冲突 Diff 必须明确呈现磁盘现态中的人工条款'
    );
  });

  test('SVG 与 CSV 草案均接入多模态 Diff 引擎，超大文件诚实降级不伪造空差异', () => {
    const svgSummary = summarizeProposalMultimodalDiff(
      makeDraftContent({
        format: 'svg',
        base_text: '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="20" height="20"/></svg>',
        disk_text: '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="20" height="20"/></svg>',
        proposed_text:
          '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="20" height="20"/><text x="15" y="45">新标注</text></svg>',
      })
    );
    assert.equal(svgSummary.modeLabel, 'SVG 视觉图元 Diff');
    assert.ok(svgSummary.addedCount >= 1);

    const csvSummary = summarizeProposalMultimodalDiff(
      makeDraftContent({
        format: 'csv',
        base_text: '模块,预算\n核心,100\n',
        disk_text: '模块,预算\n核心,100\n',
        proposed_text: '模块,预算\n核心,120\n',
      })
    );
    assert.equal(csvSummary.modeLabel, '表格数值 Diff');
    assert.ok(csvSummary.lines.some((l) => l.text.includes('100 → 120')));

    const truncatedSummary = summarizeProposalMultimodalDiff(
      makeDraftContent({ truncated: true, proposed_text: null })
    );
    assert.equal(truncatedSummary.truncated, true);
    assert.equal(truncatedSummary.modeLabel, '大文件诚实降级');
  });

  test('SSR 渲染完整呈递草案分支、回执、上下文芯片、退回重做与展开态冲突 Diff 面板', () => {
    const toast: ProposalToastData = {
      draftId: 'draft_e02_1',
      fileId: 'f_plan',
      fileName: '02-实施计划.md',
      versionLabel: 'v3-agent-draft',
      conflict: true,
      receiptSummary: '依据上游架构规范补全 CAS 守卫与回滚步骤',
      inputContextHashes: ['sha256:0123456789abcdef', 'fedcba9876543210'],
    };
    const html = renderToStaticMarkup(
      React.createElement(ProposalToast, {
        toast,
        adopting: false,
        rejecting: false,
        adoptNotice: null,
        diffExpanded: true,
        diffContent: makeDraftContent({ conflict: true }),
        onAdopt: () => {},
        onReject: () => {},
        onViewDiff: () => {},
        onOpenInReader: () => {},
        onDismiss: () => {},
      })
    );
    assert.ok(html.includes('v3-agent-draft'));
    assert.ok(html.includes('回执：依据上游架构规范补全 CAS 守卫与回滚步骤'));
    assert.ok(html.includes('依据 2 份上下文'));
    assert.ok(html.includes('0123456789ab'));
    assert.ok(html.includes('data-proposal-conflict'));
    assert.ok(html.includes('data-proposal-diff-panel'));
    assert.ok(html.includes('收起 Diff'));
    assert.ok(html.includes('退回重做'));
    assert.ok(html.includes('一键采纳'));
    assert.ok(html.includes('阅读器'));
  });
});
