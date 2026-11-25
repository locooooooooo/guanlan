import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CommandPalette,
  PALETTE_GRAMMAR_SUGGESTIONS,
  parsePaletteTokens,
  togglePaletteSuggestion,
} from '../src/components/CommandPalette';
import type { PaletteItem } from '../src/utils/commandPaletteResults';
import ReviewBoardDrawer, {
  computeReviewBoardRatioBand,
  findInitiativeIdByStatement,
  REVIEW_BOARD_LANES,
  reviewBoardLanePriority,
} from '../src/components/ReviewBoardDrawer';
import type {
  ReviewBoardCard,
  ReviewBoardCounts,
  ReviewBoardResponse,
} from '../src/services/apiTypes';
import {
  QuickPreviewModal,
  buildQuickQueueProgress,
  formatQuickQueueProgressLabel,
  resolveQuickQueueNeighborTitles,
  type QuickPreviewTarget,
} from '../src/components/QuickPreviewModal';
import { ContextCapsuleModal } from '../src/components/ContextCapsuleModal';
import type { FileRecord } from '../src/types/guanlan';

/**
 * 浮层动效与结构契约（ui-ux-polish-03-overlays）。
 *
 * 时空命令面板（Ctrl+K）双栏检索台与可点击语法胶囊：
 *  ① 动效硬契约：面板浮层所用的动效类「声明 + prefers-reduced-motion 降级」双登记；
 *     keyframes 只动 transform/opacity；时长缓动只吃 --dur-* / --ease-* 令牌；
 *     共享动效层零 will-change、零布局属性动画（motion.css §头部硬契约）。
 *  ② SSR 结构锚点：esc-layer / listbox / option / aria-selected 完整不回退；
 *     lg（≥1024px）双栏 60/40 + 右预览窗；五枚常驻语法胶囊 + Token 微标签。
 *  ③ 补全接线（源码级）：胶囊点击 / Token × 移除一律经 onQueryChange 只改 query
 *     字符串（130ms 防抖与过期响应丢弃纪律不被绕过）；呼出即聚焦、打开路径零 IO。
 *
 * 批阅看板视觉降噪、六态分布带与「已知悉」正向动效退场：
 *  ④ 六态比例带纯计算：分项和诚实分母、零态剔除、total=0 诚实空态、weight 守恒；
 *  ⑤ 泳道主次：行动泳道 primary、已办结 muted 降噪、unknown 恒 secondary
 *     （诚实标示绝不降噪，停机红线）；
 *  ⑥ 正向反馈接线：唯一触发源 = store notice.kind === 'ok'（后端 CAS 确认成功），
 *     点击回调与 busy 路径绝不直接触发；CAS 冲突分支保持 error 语义绝不染绿；
 *  ⑦ 动效契约：.glx-ack-mark / .glx-card-settle「声明 + reduce 停帧」双登记，
 *     光环纯装饰层 reduce 整层隐藏；抽屉统一 .glx-t-panel 两段式弹簧入场。
 *
 * 既有护栏不破：commandPaletteGrammar / commandPaletteResults / crossWorkspaceSearch
 * 既有口径冻结；test/b02-quick-preview.test.ts 的 Space 守卫依赖 data-esc-layer="open"；
 * test/e04-hitl-review-board.test.ts 的六态键序 / 已知悉 / 孤儿修复锚点完整不回退。
 *
 * 原位轻预览（QuickLook）与证据篮玻璃动效质感统一：
 *  ⑨ 队列进度胶囊纯函数（底栏「3 / 18」+ 前后预览提示 + 首末边界诚实文案）；
 *  ⑩ QuickPreviewModal / ContextCapsuleModal 统一 glass-pop 琉璃材质 + glx-popover-in
 *     入场；队列切换（←/→）内容区以既有 glx-fade-in（--dur-1 纯 opacity）交叉淡入；
 *  ⑪ Space <100ms 缓存命中首帧红线：80ms spinner 阈值与同步缓存命中原样不动；
 *  ⑫ 证据篮徽标 glx-badge-pop 脉冲：唯一触发源 = store 实际入篮（计数仅上升沿），
 *     绝不假乐观伪造成功。
 */

/** 读 src/ 下源文件（相对 test/ 目录，须带 ../src/ 前缀） */
function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

const noop = (): void => {};

function fileItem(overrides: Partial<PaletteItem> = {}): PaletteItem {
  return {
    kind: 'file',
    key: 'srv:f1:rev_f1',
    title: '登录方案',
    subtitle: 'docs/登录方案.md',
    format: 'md',
    matchStrategy: 'bigram_phrase_verified',
    coverage: 'full_text',
    fileId: 'f1',
    revisionId: 'rev_f1',
    relativePath: 'docs/登录方案.md',
    score: 15,
    ...overrides,
  };
}

function renderPalette(
  items: PaletteItem[],
  overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}
  ): string {
  return renderToStaticMarkup(
    createElement(CommandPalette, {
      isOpen: true,
      query: '登录',
      items,
      searching: false,
      onQueryChange: noop,
      onClose: noop,
      onOpenFile: noop,
      onLocate: noop,
      onAddToBasket: noop,
      onRunAction: noop,
      ...overrides,
    })
  );
}

// ---------- ① 动效硬契约（声明 + reduce 降级双登记） ----------

test('命令面板·动效契约：面板浮层动效类「声明 + reduce 降级」双登记，keyframes 只动 transform/opacity，全层零 will-change', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  // 三类全部是既有已登记类（不新增动效类 = 零新增降级欠账）：
  // 面板入场 glx-popover-in / 遮罩 glx-backdrop-in / 胶囊悬停触感 glx-pill-tactile
  for (const cls of ['.glx-popover-in', '.glx-backdrop-in', '.glx-pill-tactile']) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }
  // 入场 keyframes 只走 transform + opacity（合成器友好，无布局属性）
  const kfStart = motionCss.indexOf('@keyframes glx-popover-in');
  const kfEnd = motionCss.indexOf('.glx-popover-in {', kfStart);
  const keyframes = motionCss.slice(kfStart, kfEnd);
  assert.ok(keyframes.includes('opacity'), '浮层入场关键帧走 opacity');
  assert.ok(keyframes.includes('transform'), '浮层入场关键帧走 transform');
  assert.ok(
    !/\b(width|height|top|left)\s*:/.test(keyframes),
    '浮层入场禁 width/height/top/left 布局动画'
  );
  // 时长/缓动只吃 :root 令牌（不写死 ms）
  const popClass = motionCss.slice(kfEnd, motionCss.indexOf('/* 3.8', kfEnd));
  assert.ok(popClass.includes('var(--dur-2)'), '入场时长走 --dur-2 令牌');
  assert.ok(popClass.includes('var(--ease-spring)'), '入场缓动走 --ease-spring 令牌');
  // 硬契约：共享动效层禁新增常驻 will-change（去掉注释后全文扫描）
  const cssNoComment = motionCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!cssNoComment.includes('will-change'), 'motion.css 禁 will-change');
});

// ---------- ② SSR 结构锚点 ----------

test('命令面板·结构锚点：esc-layer/listbox/option/aria-selected 完整不回退 + lg 双栏 60/40 + 右预览窗', () => {
  const items: PaletteItem[] = [
    fileItem({ revisionId: 'rev_svg9', format: 'svg', coverage: 'svg_text', pendingDecisions: 2 }),
    fileItem({ key: 'srv:f2:rev_f2', fileId: 'f2' }),
  ];
  const html = renderPalette(items, { query: '@今天 登录' });
  // 无障碍与 Esc 阶梯锚点（App Esc 阶梯 / QuickLook Space 守卫依赖）
  assert.ok(html.includes('data-esc-layer="open"'), 'esc-layer 浮层标记');
  assert.ok(html.includes('role="listbox"'), '结果列表 listbox 语义');
  assert.ok(html.includes('role="option"'), '结果行 option 语义');
  assert.ok(html.includes('aria-selected="true"'), '选中行 aria-selected');
  assert.ok(html.includes('data-command-palette-input'), '呼出即输入入口');
  // 双栏与预览窗
  assert.ok(html.includes('glx-popover-in'), '面板入场柔和缩放淡入');
  assert.ok(html.includes('glx-backdrop-in'), '遮罩淡入');
  assert.ok(html.includes('lg:w-[60%]') && html.includes('lg:w-[40%]'), 'lg ≥1024px 双栏 60/40');
  assert.ok(html.includes('data-command-palette-preview'), '右实时预览窗锚点');
  assert.ok(html.includes('data-command-palette-preview-path="docs/登录方案.md"'), '完整路径');
  assert.ok(html.includes('data-command-palette-preview-hints'), '快捷动作提示（Enter/Ctrl+Enter/Tab）');
  // 预览随选中联动：首项（默认选中）携带待拍板数 → 右预览窗徽标
  const previewBody = html.slice(html.indexOf('data-command-palette-preview-body'));
  assert.ok(previewBody.includes('待拍板 2'), '预览徽标随选中联动');
  assert.ok(html.includes('aria-pressed="true"'), '已补全胶囊呈激活态');
  // 底栏键位提示常驻（既有锚点）
  assert.ok(html.includes('Ctrl+Enter') && html.includes('Tab 加入证据篮'));
});

test('命令面板·语法胶囊行：五枚常驻胶囊逐字 + aria-pressed 开关语义 + 胶囊点击即补全接线', () => {
  const html = renderPalette([], { query: '' });
  assert.ok(html.includes('data-command-palette-grammar'), '输入栏下方常驻胶囊行');
  for (const s of PALETTE_GRAMMAR_SUGGESTIONS) {
    assert.ok(html.includes(`data-palette-suggest="${s.token}"`), `胶囊锚点 ${s.token}`);
    assert.ok(html.includes(`>${s.label}</button>`), `胶囊文案逐字 ${s.label}`);
  }
  assert.ok(
    (html.match(/aria-pressed="false"/g) ?? []).length >= 5,
    '胶囊开关 aria-pressed 语义（空查询全部未激活）'
  );
  // 点击补全 = 只改 query 字符串（源码级接线锁定；不绕过 setQuery 防抖/竞态纪律）
  const src = readSrc('components/CommandPalette.tsx');
  assert.ok(
    src.includes('onClick={() => onQueryChange(togglePaletteSuggestion(query, s.token))}'),
    '胶囊点击 → onQueryChange(togglePaletteSuggestion) 补全'
  );
  assert.ok(
    src.includes('onQueryChange(removePaletteTokenAt(query, t.start))'),
    'Token × → onQueryChange(removePaletteTokenAt) 一键移除'
  );
  assert.ok(src.includes('inputRef.current?.focus()'), '呼出即聚焦（<16ms 口径）');
  // 打开/输入路径零 IO、零延迟挂载（扫描前剥掉注释，防文档词误报）
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes('await'), '打开/输入路径零 await（零 IO、零延迟挂载）');
  // 纯函数行为兜底（node 直测可跑 = 无 DOM 依赖）
  assert.equal(togglePaletteSuggestion('', '@今天'), '@今天');
  assert.equal(togglePaletteSuggestion('@今天', '@今天'), '');
  assert.equal(parsePaletteTokens('type:md').length, 1);
});

test('命令面板·Token 微标签：语法意图 token 彩色微标签 + 未识别诚实标注（数据区禁飞不适用：纯 chrome 层）', () => {
  const html = renderPalette([], { query: '@今天 type:md @近7天' });
  assert.ok(html.includes('data-command-palette-tokens'), 'Token 微标签容器');
  assert.ok(html.includes('data-palette-token="@今天"'));
  assert.ok(html.includes('data-palette-token="type:md"'));
  assert.ok(html.includes('data-palette-token="@近7天"'));
  assert.equal(
    (html.match(/data-palette-token-parsed="false"/g) ?? []).length,
    1,
    '@近7天 在冻结语法下唯一诚实未识别'
  );
  assert.ok(html.includes('未识别'), '未识别标注可见');
  // 语法 token 的 stage-ink 文字色（浅玻璃 AA 深档出口）——禁裸暗域亮色进浅卡
  assert.ok(html.includes('var(--stage-ink-blueprint-text)'), '日期 token 文字走蓝图蓝深档');
  assert.ok(html.includes('var(--stage-ink-deliver-text)'), '格式 token 文字走交付绿深档');
  // 无语法 token 的纯关键词查询：零 chip 容器
  const plain = renderPalette([], { query: '登录' });
  assert.ok(!plain.includes('data-command-palette-tokens'), '纯关键词查询零 chip（无布局抖动）');
});

// ══════════════════════════════════════════════════════════════════════════
// 批阅看板视觉降噪、六态分布带与「已知悉」正向动效退场
// ══════════════════════════════════════════════════════════════════════════

function makeBoardCard(overrides: Partial<ReviewBoardCard> = {}): ReviewBoardCard {
  return {
    initiative_id: 'init_u8',
    name: 'U8-示例专项',
    root_dir: 'U8-示例专项',
    current_stage: '决策',
    doc_state: 'pending_review',
    bucket: 'pending_decision',
    bucket_label: '待拍板',
    bucket_reason: '尚有 1 项阻塞级待确认事项（P0:0 / P1:1），拍板后自动解锁下游',
    artifact_count: 2,
    pending_p0: 0,
    pending_p1: 1,
    pending_p2: 0,
    pending_proposals: 0,
    pending_statements: [
      {
        statement_id: 'stmt_u8',
        decision_id: 'dec_u8',
        code: 'P1',
        priority: 'P1',
        question: '是否采用新比例带',
        file_id: 'f_u8',
        path: 'U8-示例专项/01-决策.md',
        line_start: 6,
      },
    ],
    proposed_drafts: [],
    slots: [],
    orphan: null,
    updated_at: '2026-11-23T10:00:00Z',
    ...overrides,
  };
}

function makeCounts(overrides: Partial<ReviewBoardCounts> = {}): ReviewBoardCounts {
  return {
    pending_decision: 0,
    awaiting_receipt: 0,
    dispatchable: 0,
    agent_running: 0,
    completed: 0,
    unknown: 0,
    total: 0,
    ...overrides,
  };
}

function makeBoard(counts: ReviewBoardCounts, items: ReviewBoardCard[]): ReviewBoardResponse {
  return {
    ok: true,
    index_generation: 3,
    generated_at: '2026-11-23T10:00:00Z',
    stall_threshold_secs: 1800,
    counts,
    items,
  };
}

function renderBoard(
  board: ReviewBoardResponse | null,
  overrides: Record<string, unknown> = {}
): string {
  return renderToStaticMarkup(
    createElement(ReviewBoardDrawer, {
      isOpen: true,
      onClose: noop,
      board,
      loading: false,
      error: null,
      busyKey: null,
      notice: null,
      onRefresh: noop,
      onJumpToStatement: noop,
      onAcknowledgeStatement: noop,
      onInspectDraft: noop,
      onRepairOrphan: noop,
      ...overrides,
    })
  );
}

// ---------- ④ 六态比例带纯计算 ----------

test('批阅看板·六态比例带纯计算：分项和诚实分母、零态剔除、total=0 诚实空态、weight 守恒', () => {
  // 常规六态：段序恒同 REVIEW_BOARD_LANES 键序；weight=count 天然守恒
  const band = computeReviewBoardRatioBand(
    makeCounts({
      pending_decision: 2,
      awaiting_receipt: 1,
      dispatchable: 1,
      agent_running: 1,
      completed: 3,
      unknown: 1,
      total: 9,
    })
  );
  assert.deepEqual(
    band.segments.map((s) => s.bucket),
    REVIEW_BOARD_LANES.map((l) => l.key),
    '段序与六态键序一致（unknown 不被并入其他态）'
  );
  assert.equal(band.total, 9);
  assert.equal(band.totalCount, 9);
  assert.equal(band.empty, false);
  assert.equal(
    band.segments.reduce((sum, s) => sum + s.weight, 0),
    band.total,
    'weight 求和守恒'
  );
  assert.ok(band.segments.every((s) => s.visible && s.weight === s.count));
  assert.equal(band.segments.find((s) => s.bucket === 'pending_decision')!.pct, 22);
  assert.equal(band.segments.find((s) => s.bucket === 'completed')!.pct, 33);

  // 零态剔除：count=0 段不可见；唯一非零段 pct=100
  const solo = computeReviewBoardRatioBand(makeCounts({ pending_decision: 5, total: 5 }));
  assert.deepEqual(
    solo.segments.filter((s) => s.visible).map((s) => s.bucket),
    ['pending_decision']
  );
  assert.equal(solo.segments.find((s) => s.bucket === 'pending_decision')!.pct, 100);
  assert.ok(solo.segments.filter((s) => !s.visible).every((s) => s.weight === 0 && s.pct === 0));

  // 诚实空态：全零即 empty（即便 counts.total 非 0 也不伪造占比）
  const empty = computeReviewBoardRatioBand(makeCounts({ total: 6 }));
  assert.equal(empty.empty, true);
  assert.equal(empty.total, 0);
  assert.ok(empty.segments.every((s) => !s.visible && s.pct === 0 && s.weight === 0));

  // 诚实分母：分项和(2) ≠ counts.total(7) 时以分项和为准，不伪装占比
  const honest = computeReviewBoardRatioBand(
    makeCounts({ pending_decision: 1, awaiting_receipt: 1, total: 7 })
  );
  assert.equal(honest.total, 2);
  assert.equal(honest.totalCount, 7);
  assert.equal(honest.segments.find((s) => s.bucket === 'pending_decision')!.pct, 50);
});

// ---------- ⑤ 泳道主次权重与 statement 反查 ----------

test('批阅看板·泳道主次：行动泳道 primary、已办结 muted、unknown 恒 secondary（诚实标示绝不降噪）', () => {
  assert.equal(reviewBoardLanePriority('pending_decision'), 'primary');
  assert.equal(reviewBoardLanePriority('awaiting_receipt'), 'primary');
  assert.equal(reviewBoardLanePriority('dispatchable'), 'secondary');
  assert.equal(reviewBoardLanePriority('agent_running'), 'secondary');
  assert.equal(reviewBoardLanePriority('completed'), 'muted');
  // 停机红线：unknown 不得被降噪归 muted
  assert.notEqual(reviewBoardLanePriority('unknown'), 'muted');
  assert.equal(reviewBoardLanePriority('unknown'), 'secondary');

  // 「已知悉」成功反馈的卡片定位出口（纯函数、无 DOM 依赖）
  const items = [
    makeBoardCard({ initiative_id: 'init_a', bucket: 'pending_decision' }),
    makeBoardCard({
      initiative_id: 'init_b',
      bucket: 'completed',
      pending_statements: [
        {
          statement_id: 'stmt_b',
          decision_id: null,
          code: 'P2',
          priority: 'P2',
          question: '次级问句',
          file_id: 'f_b',
          path: 'b.md',
          line_start: 3,
        },
      ],
    }),
  ];
  assert.equal(findInitiativeIdByStatement(items, 'stmt_u8'), 'init_a');
  assert.equal(findInitiativeIdByStatement(items, 'stmt_b'), 'init_b');
  assert.equal(findInitiativeIdByStatement(items, 'missing'), null);
  assert.equal(findInitiativeIdByStatement([], 'stmt_u8'), null);
});

// ---------- ⑥ SSR 结构：比例带 + glx-t-panel 弹簧抽屉 + 泳道降噪 ----------

test('批阅看板·SSR：六态比例带替代冗长说明、抽屉统一 glx-t-panel 两段式弹簧入场、泳道 tier 锚点', () => {
  const board = makeBoard(
    makeCounts({
      pending_decision: 1,
      awaiting_receipt: 1,
      completed: 1,
      unknown: 1,
      total: 4,
    }),
    [
      makeBoardCard({ initiative_id: 'init_pd', bucket: 'pending_decision' }),
      makeBoardCard({
        initiative_id: 'init_ar',
        bucket: 'awaiting_receipt',
        bucket_label: '待批阅回执',
        bucket_reason: '有 1 份智能体草案回执待人工批阅',
        pending_statements: [],
        proposed_drafts: [
          {
            draft_id: 'draft_u8',
            file_id: 'f_u8',
            path: 'U8-示例专项/02-草案.md',
            draft_version_label: 'v2-agent-draft',
            conflict: false,
            receipt_summary: '已补齐回执摘要',
            created_at: '2026-11-23T09:50:00Z',
          },
        ],
      }),
      makeBoardCard({
        initiative_id: 'init_done',
        bucket: 'completed',
        bucket_label: '已办结',
        bucket_reason: '全部清单、拍板与回执核验已完成',
        pending_p1: 0,
        pending_statements: [],
      }),
      makeBoardCard({
        initiative_id: 'init_un',
        bucket: 'unknown',
        bucket_label: '状态未知',
        bucket_reason: '执行槽运行超过 45 分钟仍无新回执，已诚实标为未知',
        pending_p1: 0,
        pending_statements: [],
        orphan: {
          node_id: 'node_u8',
          stage: '执行',
          reason: '执行槽运行超过 45 分钟仍无新回执',
          stalled_seconds: 2700,
          repair_actions: ['reset_to_dispatchable', 'mark_suspended_hitl'],
        },
      }),
    ]
  );
  const html = renderBoard(board);

  // 比例带替代冗长文字说明
  assert.ok(html.includes('data-review-board-ratio-band=""'), '六态比例分布带');
  for (const bucket of ['pending_decision', 'awaiting_receipt', 'completed', 'unknown']) {
    assert.ok(html.includes(`data-board-ratio-seg="${bucket}"`), `可见段 ${bucket}`);
  }
  assert.ok(
    !html.includes('data-board-ratio-seg="dispatchable"') &&
      !html.includes('data-board-ratio-seg="agent_running"'),
    '零态段被剔除（零宽段不进带）'
  );
  assert.ok(
    !html.includes('五态分流（待拍板 / 可派发 / 运行中 / 待批阅回执 / 已办结）'),
    '顶栏冗长说明被比例带替代'
  );
  assert.ok(html.includes('aria-label="批阅看板六态分布'), '比例带完整六态 aria 语义');

  // 抽屉统一 glx-t-panel 弹簧双轨（两段式入场），不再叠挂旧一次性入场 keyframes
  assert.ok(html.includes('glx-t-panel'), '抽屉弹簧双轨入场');
  assert.ok(!html.includes('glx-drawer-in'), '不再叠挂 glx-drawer-in（两套入场）');

  // 泳道主次：行动泳道 primary / 已办结 muted / unknown 保持 secondary（诚实不降噪）
  assert.ok(html.includes('data-board-tier="primary"'));
  assert.ok(html.includes('data-board-tier="muted"'));
  assert.ok(html.includes('data-board-tier="secondary"'));
  const mutedPos = html.indexOf('data-board-tier="muted"');
  const secondaryPos = html.indexOf('data-board-tier="secondary"');
  const mutedChunk = html.slice(mutedPos, secondaryPos);
  assert.ok(
    !mutedChunk.includes('全部清单、拍板与回执核验已完成'),
    '已办结降噪卡不渲染 bucket_reason'
  );

  // 正向脉冲徽记不常驻（只在后端 CAS 确认成功后出现；SSR 初始态零徽记）
  assert.ok(!html.includes('data-board-ack-pulse'), '脉冲徽记绝不预渲染');

  // 停机红线：绝无跳过人工审阅入口；unknown 孤儿诊断与安全修复完整保留
  assert.ok(!html.includes('强制完结'));
  assert.ok(!html.includes('跳过审阅'));
  assert.ok(html.includes('data-board-orphan="node_u8"'));
  assert.ok(html.includes('已静默 45 分钟'));
  assert.ok(html.includes('data-board-ack-btn="stmt_u8"'));
  assert.ok(html.includes('原位拍板'));
});

test('批阅看板·SSR 空态：全零 counts 诚实渲染空比例带（不伪装占比），看板其余锚点不回退', () => {
  const html = renderBoard(makeBoard(makeCounts({ total: 0 }), []));
  assert.ok(html.includes('data-review-board-ratio-band="empty"'), '诚实空态带');
  assert.ok(html.includes('看板暂无在办事项'), '空态文案（sr-only 语义可读）');
  assert.ok(!html.includes('data-board-ratio-seg='), '空态零段');
  assert.ok(html.includes('data-board-filter="unknown"'), '六态过滤药丸完整不回退');
  assert.ok(html.includes('data-review-board-drawer'));
  assert.ok(html.includes('data-esc-layer="open"'), 'Esc 阶梯守卫依赖不回退');
});

// ---------- ⑦ 正向反馈接线（唯一触发源 = 后端 CAS 确认成功） ----------

test('批阅看板·反馈接线：脉冲只在 notice.kind==="ok"（后端 CAS 确认）后沿 busyKey 释放沿触发，点击绝不直接触发', () => {
  const src = readSrc('components/ReviewBoardDrawer.tsx');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 门控行逐字：busyKey 释放沿 + ok notice 双条件
  assert.ok(
    codeOnly.includes('if (!prev || prev === busyKey || busyKey !== null) return;'),
    '只在 busyKey 释放沿评估（busy 路径零触发）'
  );
  assert.ok(
    codeOnly.includes("if (notice?.kind !== 'ok') return;"),
    'notice.kind==="ok" 是唯一正向门控（CAS 冲突 error 永不染绿）'
  );
  assert.ok(codeOnly.includes("prev.startsWith('ack:')"), '已知悉成功沿定位');
  assert.ok(codeOnly.includes("prev.startsWith('repair:')"), '孤儿修复成功沿定位');
  // 点击回调只透传 store（反馈状态绝不在 onClick 里 set）
  assert.ok(
    codeOnly.includes('onClick={() => onAcknowledgeStatement(stmt)}'),
    '已知悉点击只调 store 回调（后端 CAS 写回链不变）'
  );
  // store（围栏外只读断言）：CAS 冲突分支保持 error 语义、绝不染绿
  const storeSrc = readSrc('stores/useWorkspaceStore.tsx');
  const casBranch = storeSrc.slice(storeSrc.indexOf('wb && !wb.cas_ok'));
  assert.ok(casBranch.includes("kind: 'error'"), 'CAS 冲突分支保持 error（绝不假乐观染绿）');
  assert.ok(
    storeSrc.includes('已原位写回'),
    '正向 ok 文案仍锚定后端确认成功分支'
  );
});

// ---------- ⑧ 动效契约：声明 + reduce 降级双登记 ----------

test('批阅看板·动效契约：glx-ack-mark / glx-card-settle 声明与 reduce 停帧双登记，光环装饰层整层隐藏，时长零写死', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  for (const cls of ['.glx-ack-mark', '.glx-card-settle']) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }
  const ringReduce = reduceSection.slice(reduceSection.indexOf('.glx-ack-mark::after'));
  assert.ok(
    ringReduce.includes('display: none'),
    '光环是纯装饰层，reduce 下整层隐藏（终态＝徽记静态翠绿勾仍在）'
  );
  assert.ok(
    reduceSection.includes('.glx-t-panel'),
    '抽屉弹簧双轨在 reduce 下撤 transition（瞬时落位、终态可见）'
  );
  // keyframes 只动 transform/opacity（零布局属性动画）
  for (const kf of ['glx-ack-mark-in', 'glx-ack-ring-pop', 'glx-card-settle']) {
    const kfStart = motionCss.indexOf(`@keyframes ${kf}`);
    assert.ok(kfStart >= 0, `keyframes ${kf} 存在`);
    const kfEnd = motionCss.indexOf('}}', kfStart);
    const body = motionCss.slice(kfStart, kfEnd);
    assert.ok(
      !/\b(width|height|top|left)\s*:/.test(body),
      `${kf} 禁 width/height/top/left 布局动画`
    );
  }
  // 批阅看板动效新增段（§3.27 至 reduce 块前）时长缓动只吃令牌，零写死 ms
  const u08Block = motionCss.slice(
    motionCss.indexOf('§3.27'),
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  assert.ok(
    !/\d+(\.\d+)?ms/.test(u08Block),
    '批阅看板动效时长零写死 ms（只吃 --dur-* 令牌）'
  );
  assert.ok(u08Block.includes('var(--dur-2)'), '徽记弹出走 --dur-2');
  assert.ok(u08Block.includes('var(--dur-3)'), '光环扩散与卡片退场走 --dur-3');
  assert.ok(u08Block.includes('var(--ease-spring)'), '徽记弹出走 --ease-spring');
  assert.ok(u08Block.includes('var(--ease-fade)'), '光环/退场走 --ease-fade');
});

// ══════════════════════════════════════════════════════════════════════════
// 原位轻预览（QuickLook）与证据篮玻璃动效质感统一：
//  ⑨ 队列进度胶囊纯函数：底栏「3 / 18」等宽进度 + 前后预览提示 + 边界诚实文案；
//  ⑩ QuickPreviewModal SSR：glass-pop + glx-popover-in 统一琉璃入场，胶囊随队列渲染；
//  ⑪ Space <100ms 缓存命中首帧红线（源码级）：同步缓存命中与 80ms spinner 阈值原样
//     不动，交叉淡入只在 ←/→ 导航沿挂载（首帧零动画）；
//  ⑫ 证据篮徽标脉冲：唯一触发源 = store 实际入篮（计数仅上升沿），点击链零脉冲
//     （假乐观红线）；
//  ⑬ ContextCapsuleModal 琉璃统一 + 两阶段门禁锚点不回退；
//  ⑭ 动效契约：glx-badge-pop「声明 + reduce 停帧」双登记，队列淡入复用既有
//     glx-fade-in（--dur-1 纯 opacity），零新增入场类欠账。
// ══════════════════════════════════════════════════════════════════════════

function qpFile(fileId: string, title: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    file_id: fileId,
    relative_path: `${fileId}.md`,
    title,
    format: 'md',
    folder: '',
    role: '其他',
    roleProvenance: '待核对',
    topics: [],
    current_revision_id: `rev_${fileId}`,
    revisions: [
      {
        revision_id: `rev_${fileId}`,
        file_id: fileId,
        versionNumber: 1,
        content_sha256: `sha_${fileId}`,
        observed_at: '2026-11-23T10:00:00+08:00',
        sizeBytes: 1024,
        snapshotAvailable: true,
        summaryNote: '',
      },
    ],
    coverage: 'full_text',
    ...overrides,
  };
}

function qpQueue(names: [string, string][]): { queue: QuickPreviewTarget[]; files: FileRecord[] } {
  const files = names.map(([id, title]) => qpFile(id, title));
  const queue = files.map((f) => ({ fileId: f.file_id }));
  return { queue, files };
}

function renderQuickPreview(
  queue: QuickPreviewTarget[],
  files: FileRecord[],
  overrides: Record<string, unknown> = {}
): string {
  return renderToStaticMarkup(
    createElement(QuickPreviewModal, {
      isOpen: true,
      target: queue[0] ?? null,
      queue,
      files,
      indexGeneration: 3,
      onClose: noop,
      onNavigate: noop,
      onOpenFullReader: noop,
      ...overrides,
    })
  );
}

function renderCapsule(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ContextCapsuleModal, {
      isOpen: true,
      preset: null,
      onClose: noop,
      ...overrides,
    })
  );
}

// ---------- ⑨ 队列进度胶囊纯函数（底栏「3 / 18」+ 前后预览提示） ----------

test('轻预览与证据篮·队列进度纯函数：进度文案、三级标题回退、首末边界诚实提示、单份/非法索引不出胶囊', () => {
  // 进度文案（逐字「3 / 18」）
  assert.equal(formatQuickQueueProgressLabel(2, 18), '3 / 18');
  assert.equal(formatQuickQueueProgressLabel(0, 18), '1 / 18');
  assert.equal(formatQuickQueueProgressLabel(17, 18), '18 / 18');
  // 非法/越界/空队列诚实回空串（调用方据此不渲染胶囊）
  assert.equal(formatQuickQueueProgressLabel(-1, 18), '');
  assert.equal(formatQuickQueueProgressLabel(18, 18), '');
  assert.equal(formatQuickQueueProgressLabel(0, 0), '');
  assert.equal(formatQuickQueueProgressLabel(Number.NaN, 3), '');
  assert.equal(formatQuickQueueProgressLabel(0, Number.NaN), '');

  const { queue, files } = qpQueue([
    ['f_a', '登录方案'],
    ['f_b', '架构决策'],
    ['f_c', '百川采集协议'],
  ]);
  // 中位项：前后邻居标题 + 箭头提示
  const mid = buildQuickQueueProgress(queue, files, 1);
  assert.ok(mid);
  assert.equal(mid!.position, 2);
  assert.equal(mid!.total, 3);
  assert.equal(mid!.progressLabel, '2 / 3');
  assert.equal(mid!.prevTitle, '登录方案');
  assert.equal(mid!.nextTitle, '百川采集协议');
  assert.equal(mid!.prevHint, '← 上一份：登录方案');
  assert.equal(mid!.nextHint, '下一份：百川采集协议 →');
  // 首份：前侧诚实「已是第一份」
  const first = buildQuickQueueProgress(queue, files, 0)!;
  assert.equal(first.prevTitle, null);
  assert.equal(first.prevHint, '已是第一份');
  assert.equal(first.nextHint, '下一份：架构决策 →');
  // 末份：后侧诚实「已是最后一份」
  const last = buildQuickQueueProgress(queue, files, 2)!;
  assert.equal(last.nextTitle, null);
  assert.equal(last.nextHint, '已是最后一份');
  assert.equal(last.prevHint, '← 上一份：架构决策');
  // 单份队列 / 非法索引：诚实回 null（不出胶囊）
  const solo = qpQueue([['f_solo', '孤本']]);
  assert.equal(buildQuickQueueProgress(solo.queue, solo.files, 0), null);
  assert.equal(buildQuickQueueProgress(queue, files, -1), null);
  assert.equal(buildQuickQueueProgress(queue, files, 3), null);
  assert.equal(buildQuickQueueProgress([], [], 0), null);

  // 标题三级诚实回退：title → relative_path → file_id
  const noTitleFiles = [
    qpFile('f_x', '', { relative_path: '目录/未命名观察.md' }),
    qpFile('f_y', '', { relative_path: '' }),
  ];
  const noTitleQueue = noTitleFiles.map((f) => ({ fileId: f.file_id }));
  const titles = resolveQuickQueueNeighborTitles(noTitleQueue, noTitleFiles, 1);
  assert.equal(titles.prevTitle, '目录/未命名观察.md');
  assert.equal(titles.nextTitle, null);
  const fallback = resolveQuickQueueNeighborTitles(
    [{ fileId: 'f_z' }, { fileId: 'f_x' }],
    noTitleFiles,
    0
  );
  assert.equal(fallback.nextTitle, '目录/未命名观察.md');
});

// ---------- ⑩ 轻预览 SSR：琉璃统一 + 队列胶囊 + Space 首帧红线 ----------

test('轻预览与证据篮·QuickPreviewModal SSR：glass-pop + glx-popover-in 统一琉璃入场，底栏队列进度胶囊随队列渲染', () => {
  const { queue, files } = qpQueue([
    ['f_a', '登录方案'],
    ['f_b', '架构决策'],
    ['f_c', '百川采集协议'],
  ]);
  const html = renderQuickPreview(queue, files);
  // Esc 阶梯 / Space 守卫依赖不回退（useQuickPreview 全局捕获器早退依赖）
  assert.ok(html.includes('data-esc-layer="open"'), 'data-esc-layer="open" 不回退');
  assert.ok(html.includes('data-quick-preview-modal'), '轻预览根锚点');
  // 琉璃统一：glass-pop 材质（inset 顶沿高光 + 双层深影 + blur28）+ glx-popover-in
  // 柔和缩放淡入 + glx-backdrop-in 遮罩淡入；描边统一 --glass-hairline（与命令面板同配方）
  assert.ok(html.includes('glass-pop'), 'glass-pop 琉璃浮层材质');
  assert.ok(html.includes('glx-popover-in'), 'glx-popover-in 弹窗入场');
  assert.ok(html.includes('glx-backdrop-in'), 'glx-backdrop-in 遮罩淡入');
  assert.ok(html.includes('border-[color:var(--glass-hairline)]'), '描边统一 --glass-hairline');
  assert.ok(!html.includes('border-white/75'), '组件私货白描边清零（材质单一来源）');
  // 底栏队列进度胶囊：等宽进度 + 前后预览提示（首份边界诚实提示）
  assert.ok(html.includes('data-quick-preview-queue-pill'), '底栏队列进度胶囊');
  assert.ok(html.includes('1 / 3'), '等宽进度文案（tabular-nums）');
  assert.ok(html.includes('已是第一份'), '首份前侧诚实提示');
  assert.ok(html.includes('下一份：架构决策 →'), '后侧邻居预览提示');
  assert.ok(html.includes('tabular-nums'), '进度数字等宽唯一出口');
  // 中位项：双向邻居提示、无边界文案
  const midHtml = renderQuickPreview(queue, files, { target: queue[1] });
  assert.ok(midHtml.includes('2 / 3'));
  assert.ok(midHtml.includes('← 上一份：登录方案'));
  assert.ok(midHtml.includes('下一份：百川采集协议 →'));
  assert.ok(!midHtml.includes('已是最后一份'));
  // 单份队列：不出胶囊（诚实边界）
  const solo = qpQueue([['f_solo', '孤本']]);
  assert.ok(!renderQuickPreview(solo.queue, solo.files).includes('data-quick-preview-queue-pill'));
});

test('轻预览与证据篮·首帧红线（源码级）：缓存命中同步路径与 80ms spinner 阈值原样不动，交叉淡入只在 ←/→ 导航沿挂载', () => {
  const src = readSrc('components/QuickPreviewModal.tsx');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 停机红线：Space <100ms 缓存命中首帧 —— 同步缓存命中 + 80ms spinner 阈值不得前移
  assert.ok(
    codeOnly.includes('getCachedQuickPreview(resolvedRevisionId, 0)'),
    '同步缓存命中路径保留（首帧零闪烁）'
  );
  assert.ok(codeOnly.includes('}, 80);'), '80ms spinner 阈值原样保留（不提前、不闪）');
  // 队列切换交叉淡入 = 既有 .glx-fade-in（--dur-1 纯 opacity，数据区唯一入场式）；
  // 只在「已打开后的导航沿」挂载：navSeq 门控 + key 重挂，首帧（navSeq=0）零动画
  assert.ok(codeOnly.includes('navSeq > 0'), '入场类只在导航沿挂载（首帧零动画）');
  assert.ok(
    codeOnly.includes("'glx-fade-in flex-1 min-h-0 flex flex-col overflow-hidden'"),
    '队列切换内容区走既有 .glx-fade-in（--dur-1 纯 opacity）'
  );
  assert.ok(codeOnly.includes('navPrev.index !== currentIndex'), '导航沿判定（←/→ 才重挂）');
  assert.ok(codeOnly.includes('data-quick-preview-body'), '内容区 wrapper 锚点');
  // 数据区禁飞：交叉淡入不得引入位移类（glx-fade-in 是纯 opacity 唯一合法式）
  assert.ok(!codeOnly.includes('glx-card-in'), '内容区禁 chrome 位移入场类');
  assert.ok(!codeOnly.includes('glx-row-in'), '内容区禁行级位移入场类');
  // 弹窗本体入场 = 既有 glx-popover-in / glx-backdrop-in（复用预设，零新增入场类欠账）
  assert.ok(codeOnly.includes('glass-pop glx-popover-in'), '弹窗本体复用 glx-popover-in 预设');
});

// ---------- ⑪ 证据篮徽标脉冲：唯一触发源 = store 实际入篮 ----------

test('轻预览与证据篮·徽标脉冲接线：TopHeader 只在计数上升沿触发 glx-badge-pop（store 实际入篮事实源），点击链零脉冲', () => {
  const headerSrc = readSrc('components/TopHeader.tsx');
  const headerCode = headerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 触发门控：仅上升沿（store 的 contextPointers.length 增长 = 实际入篮落地）
  assert.ok(
    headerCode.includes('contextBasketCount > basketPrev'),
    '脉冲只在计数上升沿评估（移除/清空减量沿零触发）'
  );
  assert.ok(
    headerCode.includes('basketPrev !== null &&'),
    '首挂零基线不触发（应用启动零空脉冲）'
  );
  // 播放机制：key 重挂 + 动画类只在 pulseSeq > 0 时挂载
  assert.ok(
    headerCode.includes("basketPulseSeq > 0 ? 'glx-badge-pop'"),
    '脉冲类只在上升沿后挂载（首挂零动画类）'
  );
  assert.ok(
    headerCode.includes('basket-pulse-${basketPulseSeq}'),
    'key 重挂重播一次性动画'
  );
  assert.ok(headerCode.includes('data-context-basket-badge'), '徽标锚点');
  assert.ok(
    headerCode.includes('aria-label={`已收集 ${contextBasketCount} 条上下文`}'),
    '徽标语义可读'
  );

  // 事实源锁定（围栏外只读断言）：计数派生自 store 真实入篮，点击回调不在触发链上
  const storeSrc = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(
    storeSrc.includes('setContextPointers((prev) => [pointer, ...prev])'),
    'store 实际入篮事实源（前插 contextPointers）'
  );
  const appSrc = readSrc('App.tsx');
  assert.ok(
    appSrc.includes('contextBasketCount={contextPointers.length}'),
    '顶栏计数直连 store 长度（非本地乐观计数）'
  );
  // 假乐观红线：脉冲类绝不出现在 QuickLook 点击链 / 装配层（ok !== false 乐观口径不染指脉冲）
  assert.ok(
    !readSrc('components/QuickPreviewModal.tsx').includes('glx-badge-pop'),
    'QuickPreviewModal 点击回调零脉冲（假乐观禁止）'
  );
  assert.ok(
    !readSrc('components/app/AppModalsStack.tsx').includes('glx-badge-pop'),
    '装配层零脉冲'
  );
});

// ---------- ⑫ 胶囊弹窗琉璃统一 + 两阶段门禁锚点不回退 ----------

test('轻预览与证据篮·ContextCapsuleModal SSR：统一 glass-pop + glx-popover-in 琉璃材质，两阶段门禁锚点原样保留', () => {
  const html = renderCapsule();
  // 琉璃统一：glass-pop（inset 顶沿白线高光 + 双层深影 + blur28）+ 柔和入场
  assert.ok(html.includes('glass-pop'), 'glass-pop 琉璃浮层材质');
  assert.ok(html.includes('glx-popover-in'), 'glx-popover-in 弹窗入场');
  assert.ok(html.includes('glx-backdrop-in'), 'glx-backdrop-in 遮罩淡入');
  assert.ok(
    html.includes('bg-[color:var(--ink-anchor)]/40'),
    '遮罩统一 ink-anchor/40（与轻预览/命令面板同款）'
  );
  // 旧工程态材质清零：黑幕遮罩与私货描边/底色退役
  assert.ok(!html.includes('bg-black/45'), '旧 bg-black/45 遮罩清零');
  assert.ok(
    !html.includes('bg-[color:var(--depth-2-bg,white)]'),
    '私货 depth-2 底色清零（材质单一来源）'
  );
  // 两阶段门禁锚点不回退
  assert.ok(html.includes('data-capsule-mode="with_snapshots"'), '带快照模式锚点');
  assert.ok(html.includes('data-capsule-mode="manifest_only"'), '仅清单模式锚点');
  assert.ok(html.includes('data-capsule-submit'), '导出提交锚点');
  assert.ok(html.includes('打包胶囊') && html.includes('秒开 / 核验胶囊'), '双 tab 文案');
  // 源码级：两阶段门禁令牌原样（preview → token → confirmed_preview: true 才可导出）
  const capsuleSrc = readSrc('components/ContextCapsuleModal.tsx');
  for (const token of [
    'previewCapsule',
    'exportCapsule',
    'inspectCapsuleDir',
    'readCapsuleFile',
    'confirmed_preview: true',
    'data-capsule-confirm',
  ]) {
    assert.ok(capsuleSrc.includes(token), `胶囊两阶段门禁令牌保留：${token}`);
  }
});

// ---------- ⑬ 动效契约：声明 + reduce 降级双登记 ----------

test('轻预览与证据篮·动效契约：glx-badge-pop 声明与 reduce 停帧双登记、keyframes 只动 transform、队列淡入复用 glx-fade-in（--dur-1）', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  // 复用与新增的动效类「声明 + reduce 降级」双登记
  for (const cls of [
    '.glx-badge-pop', // 证据篮徽标脉冲类
    '.glx-popover-in', // 复用：弹窗入场
    '.glx-backdrop-in', // 复用：遮罩入场
    '.glx-fade-in', // 复用：队列切换交叉淡入（--dur-1 纯 opacity）
  ]) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }
  // glx-badge-pop keyframes 只动 transform（零布局属性动画）
  const kfStart = motionCss.indexOf('@keyframes glx-badge-pop');
  assert.ok(kfStart >= 0, 'keyframes glx-badge-pop 存在');
  const nextKf = motionCss.indexOf('@keyframes', kfStart + 1);
  const kfBody = motionCss.slice(kfStart, nextKf > 0 ? nextKf : kfStart + 800);
  assert.ok(kfBody.includes('transform'), '徽标脉冲走 transform 微缩放');
  assert.ok(
    !/\b(width|height|top|left)\s*:/.test(kfBody),
    '徽标脉冲禁 width/height/top/left 布局动画'
  );
  // 徽标脉冲新增段（§3.28 至 reduce 块前）时长缓动只吃令牌，零写死 ms
  const u09Block = motionCss.slice(
    motionCss.indexOf('§3.28'),
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  assert.ok(!/\d+(\.\d+)?ms/.test(u09Block), '徽标脉冲动效时长零写死 ms（只吃 --dur-* 令牌）');
  assert.ok(u09Block.includes('var(--dur-2)'), '徽标脉冲走 --dur-2');
  assert.ok(u09Block.includes('var(--ease-spring)'), '徽标脉冲走 --ease-spring');
  const u09CssNoComment = u09Block.replace(/\/\*[\s\S]*?\*\//g, '');
  // 声明形扫描（带冒号）：切片自注释中部起，裸词 will-change 会命中注释文字，
  // 以 `will-change:` 才是 CSS 声明（§3.28 头注释只作禁令记载）。
  assert.ok(!u09CssNoComment.includes('will-change:'), '徽标脉冲段零 will-change 声明');
  // 队列切换交叉淡入 = 既有 glx-fade-in（--dur-1 --ease-fade 纯 opacity）
  assert.ok(
    motionCss.includes('animation: glx-fade-in var(--dur-1) var(--ease-fade) both'),
    '队列交叉淡入复用 glx-fade-in（--dur-1 --ease-fade）'
  );
});

