import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import ReadingIsland, { IslandRing, ReadingIslandPanel } from '../src/components/ReadingIsland';
import {
  computeReadingIslandStats,
  formatIslandQuotaLine,
  islandPercent,
} from '../src/utils/readingIslandStats';
import type { FileRecord, ReadingState, WorkspaceConfig } from '../src/types/guanlan';

/**
 * 右缘「阅读与存档」悬浮岛（参考贴屏黑岛 + 三进度环）。
 *
 * 三个问题一张岛答完：哪些已读 / 哪些未读 / 哪些已落盘存档。
 * 口径全部复用既有判定：已读/未读走 hasUnreadChanges 三态（up_to_date 记已读），
 * 落盘取当前版本 snapshotAvailable（被配额淘汰 = 未落盘），配额水位取 config.quota 真实值。
 *
 * 测试分两层：纯函数（computeReadingIslandStats/islandPercent/
 * formatIslandQuotaLine）+ renderToString 结构断言（node 无 DOM 事件，点击接线由
 * onClick 代码保证，见文末对账注释）。
 */

// ---------- 夹具：最小 FileRecord / ReadingState ----------

let seq = 0;
interface FileOpts {
  title?: string;
  path?: string;
  format?: 'md' | 'svg' | 'pdf';
  /** 当前版本快照是否在存档区（默认 true） */
  persisted?: boolean;
}

function file(opts: FileOpts = {}): FileRecord {
  seq += 1;
  const revId = `rev_${String(seq).padStart(3, '0')}`;
  return {
    file_id: `f_island_${String(seq).padStart(3, '0')}`,
    folder: 'docs',
    title: opts.title ?? `文档 ${seq}`,
    relative_path: opts.path ?? `docs/doc-${seq}.md`,
    format: opts.format ?? 'md',
    current_revision_id: revId,
    coverage: 'full_text',
    role: '说明',
    revisions: [
      {
        revision_id: revId,
        versionNumber: 1,
        observed_at: '2026-11-01T10:00:00+08:00',
        snapshotAvailable: opts.persisted ?? true,
        summaryNote: '',
      },
    ],
  } as unknown as FileRecord;
}

interface StateOpts {
  /** 已读基线指向的 revision_id；缺省 = 从未读过 */
  baselineOf?: string;
  scrollPercent?: number;
  updatedAt?: string;
}

function state(opts: StateOpts = {}): ReadingState {
  return {
    file_id: 'f_placeholder',
    scrollPercent: opts.scrollPercent ?? 0,
    isFullyRead: false,
    bookmarked: false,
    updated_at: opts.updatedAt ?? '2026-11-10T09:00:00+08:00',
    ...(opts.baselineOf ? { last_read_revision_id: opts.baselineOf } : {}),
  };
}

const EMPTY_STATES = {};

/** React 会在相邻文本节点间插入 <!-- -->（如 {percent}%），断言前剥掉 */
function stripComments(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

// ---------- 纯函数层：三态聚合 + 落盘判定 ----------

test('悬浮岛聚合：已读/未读按三态分桶，落盘按当前版本 snapshotAvailable', () => {
  // ① 已读最新：基线 = 当前版本 → up_to_date → 已读
  const readDoc = file({ title: '已读完' });
  // ② 从未读过：无阅读记录 → never_read → 未读
  const neverDoc = file({ title: '从未读' });
  // ③ 读过但有更新：基线 ≠ 当前版本 → updated_since_last_read → 未读
  //    基线版本快照已被淘汰 → diff 走 REVISION_UNAVAILABLE 短路（fixture 不需要正文）
  const updatedDoc = file({ title: '有更新' });
  updatedDoc.revisions.unshift({
    revision_id: 'rev_old',
    versionNumber: 0,
    observed_at: '2026-10-01T10:00:00+08:00',
    snapshotAvailable: false, // 基线快照已淘汰
    summaryNote: '',
  } as never);
  // ④ 快照被配额淘汰：当前版本 snapshotAvailable=false → 未落盘
  const evictedDoc = file({ title: '快照淘汰', persisted: false });

  const stats = computeReadingIslandStats(
    [readDoc, neverDoc, updatedDoc, evictedDoc],
    {
      [readDoc.file_id]: state({ baselineOf: readDoc.current_revision_id, scrollPercent: 100 }),
      [updatedDoc.file_id]: state({ baselineOf: 'rev_old', scrollPercent: 40 }),
    }
  );

  assert.equal(stats.total, 4);
  assert.equal(stats.read, 1, '只有 up_to_date 记已读');
  assert.equal(stats.unread, 3, 'never_read 与 updated_since_last_read 都记未读（快照淘汰那份也无阅读记录）');
  assert.equal(stats.persisted, 3, '快照淘汰的那份不算已落盘');

  const byId = new Map(stats.entries.map((e) => [e.fileId, e]));
  assert.equal(byId.get(readDoc.file_id)!.readStatus, 'read');
  assert.equal(byId.get(neverDoc.file_id)!.readStatus, 'unread');
  assert.equal(byId.get(neverDoc.file_id)!.unreadReason, 'never_read');
  assert.equal(byId.get(updatedDoc.file_id)!.readStatus, 'unread');
  assert.equal(byId.get(updatedDoc.file_id)!.unreadReason, 'updated_since_last_read');
  assert.equal(byId.get(evictedDoc.file_id)!.persisted, false, '配额淘汰 = 未落盘');
  assert.equal(byId.get(updatedDoc.file_id)!.scrollPercent, 40, '滚动比例如实透出');
});

test('悬浮岛聚合：同标题拷贝带最小区分前缀，无冲突时不加前缀', () => {
  const a = file({ title: 'PLAN', path: 'runs/run-A/PLAN.md' });
  const b = file({ title: 'PLAN', path: 'runs/run-B/PLAN.md' });
  const solo = file({ title: '独一无二', path: 'docs/unique.md' });
  const stats = computeReadingIslandStats([a, b, solo], EMPTY_STATES);
  const byId = new Map(stats.entries.map((e) => [e.fileId, e]));
  assert.equal(byId.get(a.file_id)!.dirPrefix, 'run-A', '重名拷贝以末段目录区分（互相可指认）');
  assert.equal(byId.get(b.file_id)!.dirPrefix, 'run-B');
  assert.equal(byId.get(solo.file_id)!.dirPrefix, '', '无同名冲突不加前缀');
});

test('悬浮岛聚合：组内按最近阅读降序，无记录靠后，同序按路径稳定', () => {
  const older = file({ title: '早读', path: 'a.md' });
  const newer = file({ title: '晚读', path: 'b.md' });
  const never = file({ title: '从未', path: 'c.md' });
  const stats = computeReadingIslandStats([older, newer, never], {
    [older.file_id]: state({ baselineOf: older.current_revision_id, updatedAt: '2026-11-01T09:00:00+08:00' }),
    [newer.file_id]: state({ baselineOf: newer.current_revision_id, updatedAt: '2026-11-12T09:00:00+08:00' }),
  });
  assert.deepEqual(
    stats.entries.map((e) => e.title),
    ['晚读', '早读', '从未'],
    'updated_at 新的在前；无阅读记录的排最后'
  );
});

test('悬浮岛聚合：空文件列表返回全 0，不炸', () => {
  const stats = computeReadingIslandStats([], EMPTY_STATES);
  assert.deepEqual(
    { total: stats.total, read: stats.read, unread: stats.unread, persisted: stats.persisted, entries: stats.entries },
    { total: 0, read: 0, unread: 0, persisted: 0, entries: [] }
  );
});

test('悬浮岛纯函数：islandPercent 取整与空总数兜底；配额行上限未知如实标注', () => {
  assert.equal(islandPercent(1, 3), 33);
  assert.equal(islandPercent(2, 3), 67);
  assert.equal(islandPercent(0, 0), 0, '空总数返回 0，悬浮岛由 App 在 files 为空时不渲染');
  assert.equal(islandPercent(5, 0), 0);

  const quota = { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'];
  assert.equal(formatIslandQuotaLine(quota), '存档区 12 / 50 MiB');
  const noLimit = { usedTotalMiB: 7, maxTotalMiB: 0 } as WorkspaceConfig['quota'];
  assert.equal(formatIslandQuotaLine(noLimit), '存档区 已用 7 MiB · 上限未知', '上限缺失不虚构配额');
});

// ---------- 渲染层（renderToString）：收起态三环 + 展开态面板 ----------

function islandFixture(): { files: FileRecord[]; states: Record<string, ReadingState> } {
  const readDoc = file({ title: '已读完', path: 'docs/done.md' });
  const neverDoc = file({ title: '从未读', path: 'docs/never.md' });
  const evictedDoc = file({ title: '快照淘汰', path: 'docs/evicted.md', persisted: false });
  const states: Record<string, ReadingState> = {
    [readDoc.file_id]: state({ baselineOf: readDoc.current_revision_id, scrollPercent: 100 }),
  };
  return { files: [readDoc, neverDoc, evictedDoc], states };
}

test('悬浮岛收起态：顶栏走极简静默单图标；inline 形态渲染三环进度，默认不展开面板', () => {
  const { files, states } = islandFixture();
  const headerHtml = stripComments(
    renderToString(
      createElement(ReadingIsland, {
        placement: 'header',
        files,
        readingStates: states,
        quota: { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
        onOpenDoc: () => {},
      })
    )
  );
  assert.ok(headerHtml.includes('data-island-pill=""'), '顶栏触发器在位');
  assert.equal(headerHtml.split('data-island-ring').length - 1, 0, '顶栏态不再渲染三枚彩色小圆环');
  assert.ok(headerHtml.includes('已读 1 · 未读 2 · 已落盘 2 / 共 3 份'), '顶栏 title 完整透出三项真实计数');
  assert.ok(headerHtml.includes('aria-expanded="false"'), '收起态 pill 声明未展开');
  assert.equal(headerHtml.split('data-island-panel').length - 1, 0, '收起态不渲染面板');

  const inlineHtml = stripComments(
    renderToString(
      createElement(ReadingIsland, {
        placement: 'inline',
        files,
        readingStates: states,
        quota: { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
        onOpenDoc: () => {},
      })
    )
  );

  assert.equal(inlineHtml.split('data-island-ring').length - 1, 3, '已读/未读/已落盘 三环');
  assert.ok(inlineHtml.includes('data-island-ring="已读"'), '环语义标记齐全');
  assert.ok(inlineHtml.includes('data-island-ring="未读"'));
  assert.ok(inlineHtml.includes('data-island-ring="已落盘"'));
  assert.ok(inlineHtml.includes('>33%</span>'), '已读 1/3 → 33%');
  assert.ok(inlineHtml.includes('>67%</span>'), '未读 2/3 → 67%');
  assert.ok(
    inlineHtml.includes('aria-label="已落盘 2/3 · 67%"'),
    '落盘环按快照可用性计数（1 份被配额淘汰 → 2/3）'
  );
  assert.ok(inlineHtml.includes('aria-label="已读 1/3 · 33%"'), 'aria 带真实计数（虚报不可发生）');
});

test('悬浮岛展开面板：分组清单 + 配额水位 + 落盘徽标，未读文案与已读状态口径同源', () => {
  const { files, states } = islandFixture();
  const stats = computeReadingIslandStats(files, states);
  const html = renderToString(
    createElement(ReadingIslandPanel, {
      stats,
      quota: { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('data-island-panel'), '面板容器在');
  assert.ok(html.includes('存档区 12 / 50 MiB'), '配额水位一行小字（真实 config.quota 值）');
  assert.equal(html.split('data-island-doc-row').length - 1, 3, '清单行数 = 文档总数');
  assert.equal(html.split('data-persist-badge').length - 1, 3, '每行一枚落盘徽标');
  assert.ok(html.includes('已落盘'), '落盘徽标文案');
  assert.ok(html.includes('未落盘'), '配额淘汰的文档如实标未落盘');
  assert.ok(html.includes('data-island-section="已读"'), '按已读/未读分组');
  assert.ok(html.includes('data-island-section="未读"'));
  assert.ok(
    html.includes('未读新件（尚未建立阅读基线）'),
    'never_read 文案逐字来自 unreadStatusLabel（两态术语唯一出口）'
  );
  assert.ok(html.includes('收起阅读与存档面板'), '面板关闭按钮可达');
});

test('悬浮岛面板：配额上限缺失显示「上限未知」，空分组显示「暂无」', () => {
  const readDoc = file({ title: '已读完' });
  const stats = computeReadingIslandStats([readDoc], {
    [readDoc.file_id]: state({ baselineOf: readDoc.current_revision_id }),
  });
  const html = renderToString(
    createElement(ReadingIslandPanel, {
      stats,
      quota: { usedTotalMiB: 7, maxTotalMiB: 0 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
      onClose: () => {},
    })
  );
  assert.ok(html.includes('上限未知'), 'maxTotalMiB=0 时不虚构配额上限');
  assert.ok(html.includes('暂无'), '空分组（此处为未读组）显示「暂无」占位');
});

test('悬浮岛环组件：0% 只画轨道，100% 满弧；aria 与 title 同源', () => {
  const zero = renderToString(
    createElement(IslandRing, {
      label: '已落盘',
      percent: 0,
      count: 0,
      total: 3,
      color: '#9B8AFB',
      icon: null,
    })
  );
  assert.ok(zero.includes('aria-label="已落盘 0/3 · 0%"'));
  assert.ok(!zero.includes('stroke-dasharray'), '0% 不画进度弧，只剩轨道');

  const full = renderToString(
    createElement(IslandRing, {
      label: '已读',
      percent: 100,
      count: 3,
      total: 3,
      color: '#788C5D',
      icon: null,
    })
  );
  assert.ok(full.includes('stroke-dashoffset="0"'), '100% 时弧画满（offset=0）');
});

/**
 * 接线对账（node 无 DOM 事件，由代码走查保证）：
 * - data-island-pill onClick → setExpanded 切换展开态（ReadingIsland.tsx 本体）；
 * - data-island-doc-row onClick → onOpenDoc(fileId) + 收起面板；App 侧接
 *   openDocResumeReading（续读入口，与左栏 onOpenFileToRead 同一函数，不复制逻辑）；
 * - 面板 X 按钮 onClick → onClose 收起面板。
 */
