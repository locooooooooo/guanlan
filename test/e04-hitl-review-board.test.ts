/**
 * E04 · 原位拍板（HITL）唤醒任务与批次「批阅看板」联动前端契约单测。
 *
 * 覆盖：
 *  1. DecisionResolveCard：「确认拍板」与「已知悉」双通道渲染，缺失服务端陈述时诚实双禁用；
 *  2. ReviewBoardDrawer 纯函数：五态分栏过滤 + 失联时长中文格式化 + 待关注计数聚合；
 *  3. ReviewBoardDrawer SSR：五态分栏 + 失联 unknown 孤儿诊断与安全修复入口
 *     （reset_to_dispatchable / mark_suspended_hitl），绝不存在跳过人工审阅直接完结按钮。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import DecisionResolveCard from '../src/components/DecisionResolveCard';
import ReviewBoardDrawer, {
  filterReviewBoardCards,
  formatStallDuration,
  REVIEW_BOARD_LANES,
  reviewBoardAttentionCount,
} from '../src/components/ReviewBoardDrawer';
import type {
  ReviewBoardCard,
  ReviewBoardResponse,
  StatementDetailDTO,
} from '../src/services/apiTypes';
import type { DecisionBlock } from '../src/utils/decisionBlocks';

function makeCard(overrides: Partial<ReviewBoardCard> = {}): ReviewBoardCard {
  return {
    initiative_id: 'init_03',
    name: '03-批阅专项',
    root_dir: '03-批阅专项',
    current_stage: '决策',
    doc_state: 'pending_review',
    bucket: 'pending_decision',
    bucket_label: '待拍板',
    bucket_reason: '尚有 1 项阻塞级待确认事项（P0:0 / P1:1），拍板后自动解锁下游',
    artifact_count: 3,
    pending_p0: 0,
    pending_p1: 1,
    pending_p2: 0,
    pending_proposals: 0,
    pending_statements: [
      {
        statement_id: 'stmt_1',
        decision_id: 'dec_1',
        code: 'P1',
        priority: 'P1',
        question: '是否开放孤儿修复入口',
        file_id: 'f_dec',
        path: '03-批阅专项/03-待确认决策.md',
        line_start: 12,
      },
    ],
    proposed_drafts: [],
    slots: [
      {
        node_id: 'n_dec',
        stage: '决策',
        node_kind: 'await_decision',
        state: 'suspended_on_hitl',
        latest_checkpoint_id: null,
        latest_checkpoint_status: null,
        updated_at: '2026-11-21T10:00:00Z',
      },
    ],
    orphan: null,
    updated_at: '2026-11-21T10:00:00Z',
    ...overrides,
  };
}

describe('E04 DecisionResolveCard 原位拍板与「已知悉」快捷写回', () => {
  const block: DecisionBlock = {
    line: 12,
    range: [12, 18],
    priority: 'P1',
    priorities: ['P1'],
    blocking: true,
    status: '待确认',
    title: '是否开放孤儿修复入口',
    fields: { decision: 13, confirmer: 14 },
  };
  const stmt: StatementDetailDTO = {
    statement_id: 'stmt_1',
    revision_id: 'rev_1',
    code: 'P1',
    question: '是否开放孤儿修复入口',
    status: '待确认',
    line_start: 12,
    line_end: 18,
    decision_id: 'dec_1',
    options: ['采用人工显式修复'],
    recommendation: '采用人工显式修复',
    impact_blocked: ['执行阶段'],
    impact_allowed: [],
    confirmer_hint: '架构师',
  };

  test('有服务端陈述时渲染「确认拍板」与「已知悉」按钮且「已知悉」可用', () => {
    const html = renderToStaticMarkup(
      React.createElement(DecisionResolveCard, {
        block,
        statement: stmt,
        presetOptions: ['采用人工显式修复'],
        paperLightMode: true,
        submitting: false,
        onSubmit: () => {},
      })
    );
    assert.ok(html.includes('data-decision-submit="12"'));
    assert.ok(html.includes('确认拍板'));
    assert.ok(html.includes('data-decision-ack="12"'));
    assert.ok(html.includes('已知悉'));
    assert.ok(!/data-decision-ack="12"[^>]*disabled/.test(html), '有 statement 时已知悉应可点击');
  });

  test('无服务端陈述时「确认拍板」与「已知悉」双双诚实禁用（绝不伪造写回）', () => {
    const html = renderToStaticMarkup(
      React.createElement(DecisionResolveCard, {
        block,
        statement: null,
        presetOptions: ['采用人工显式修复'],
        paperLightMode: true,
        submitting: false,
        onSubmit: () => {},
      })
    );
    assert.ok(/disabled=""[^>]*data-decision-ack="12"|data-decision-ack="12"[^>]*disabled/.test(html));
  });
});

describe('E04 ReviewBoardDrawer 五态批阅看板与孤儿修复', () => {
  test('纯函数：五态 + unknown 过滤、失联时长格式化与待关注聚合', () => {
    assert.deepEqual(
      REVIEW_BOARD_LANES.map((l) => l.key),
      ['pending_decision', 'awaiting_receipt', 'dispatchable', 'agent_running', 'completed', 'unknown']
    );
    const items = [
      makeCard({ initiative_id: 'a', bucket: 'pending_decision' }),
      makeCard({ initiative_id: 'b', bucket: 'unknown' }),
      makeCard({ initiative_id: 'c', bucket: 'completed' }),
    ];
    assert.equal(filterReviewBoardCards(items, 'all').length, 3);
    assert.deepEqual(
      filterReviewBoardCards(items, 'unknown').map((x) => x.initiative_id),
      ['b']
    );
    assert.equal(formatStallDuration(45), '45 秒');
    assert.equal(formatStallDuration(2700), '45 分钟');
    assert.equal(formatStallDuration(5400), '1 小时 30 分钟');

    const board: ReviewBoardResponse = {
      ok: true,
      index_generation: 5,
      generated_at: '2026-11-21T12:00:00Z',
      stall_threshold_secs: 1800,
      counts: {
        pending_decision: 2,
        dispatchable: 1,
        agent_running: 1,
        awaiting_receipt: 1,
        completed: 3,
        unknown: 1,
        total: 9,
      },
      items,
    };
    assert.equal(reviewBoardAttentionCount(board), 4);
    assert.equal(reviewBoardAttentionCount(null), 0);
  });

  test('SSR 渲染五态分栏、待拍板已知悉、待审草案回执与 unknown 孤儿修复（绝无直接完结按钮）', () => {
    const board: ReviewBoardResponse = {
      ok: true,
      index_generation: 12,
      generated_at: '2026-11-21T12:00:00Z',
      stall_threshold_secs: 1800,
      counts: {
        pending_decision: 1,
        dispatchable: 0,
        agent_running: 0,
        awaiting_receipt: 1,
        completed: 0,
        unknown: 1,
        total: 3,
      },
      items: [
        makeCard({
          initiative_id: 'init_orphan',
          name: '04-失联专项',
          bucket: 'unknown',
          bucket_label: '状态未知',
          bucket_reason: '执行槽运行超过 45 分钟仍无新回执，已诚实标为未知',
          pending_p1: 0,
          pending_statements: [],
          orphan: {
            node_id: 'node_exec_1',
            stage: '执行',
            reason: '执行槽运行超过 45 分钟仍无新回执',
            stalled_seconds: 2700,
            repair_actions: ['reset_to_dispatchable', 'mark_suspended_hitl'],
          },
        }),
        makeCard(),
        makeCard({
          initiative_id: 'init_receipt',
          name: '05-待审草案专项',
          bucket: 'awaiting_receipt',
          bucket_label: '待批阅回执',
          bucket_reason: '有 1 份智能体草案回执待人工批阅',
          pending_p1: 0,
          pending_proposals: 1,
          pending_statements: [],
          proposed_drafts: [
            {
              draft_id: 'draft_99',
              file_id: 'f_99',
              path: '05-待审草案专项/02-计划.md',
              draft_version_label: 'v2-agent-draft',
              conflict: false,
              receipt_summary: '已补齐回滚预案',
              created_at: '2026-11-21T11:50:00Z',
            },
          ],
        }),
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(ReviewBoardDrawer, {
        isOpen: true,
        onClose: () => {},
        board,
        loading: false,
        error: null,
        busyKey: null,
        notice: null,
        onRefresh: () => {},
        onJumpToStatement: () => {},
        onAcknowledgeStatement: () => {},
        onInspectDraft: () => {},
        onRepairOrphan: () => {},
      })
    );

    assert.ok(html.includes('data-review-board-drawer'));
    assert.ok(html.includes('data-board-filter="pending_decision"'));
    assert.ok(html.includes('data-board-filter="dispatchable"'));
    assert.ok(html.includes('data-board-filter="agent_running"'));
    assert.ok(html.includes('data-board-filter="awaiting_receipt"'));
    assert.ok(html.includes('data-board-filter="completed"'));
    assert.ok(html.includes('data-board-filter="unknown"'));
    // 待拍板已知悉 + 原位拍板
    assert.ok(html.includes('data-board-ack-btn="stmt_1"'));
    assert.ok(html.includes('原位拍板'));
    // 待批阅回执
    assert.ok(html.includes('v2-agent-draft'));
    assert.ok(html.includes('查看 Diff 批阅'));
    // 失联 unknown 孤儿诊断与安全修复
    assert.ok(html.includes('data-board-orphan="node_exec_1"'));
    assert.ok(html.includes('已静默 45 分钟'));
    assert.ok(html.includes('data-board-repair="init_orphan:reset_to_dispatchable"'));
    assert.ok(html.includes('data-board-repair="init_orphan:mark_suspended_hitl"'));
    // 停机红线：绝无强制完结或跳过审阅按钮
    assert.ok(!html.includes('强制完结'));
    assert.ok(!html.includes('跳过审阅'));
  });
});
