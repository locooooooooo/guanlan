import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactStateView, InitiativeStateView, SearchHitDto } from '../services/apiTypes';
import type { PaletteFileLite } from './commandPaletteResults';
import { parsePaletteQuery } from './commandPaletteGrammar';
import {
  assemblePaletteResults,
  builtinActions,
  localFileHits,
  mergeHits,
  recentViewedItems,
  serverHitsToItems,
  type PaletteItem,
} from './commandPaletteResults';
import type { ReadingState } from '../types/guanlan';


function file(id: string, path: string, overrides: Partial<PaletteFileLite> = {}): PaletteFileLite {
  const base = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
  return {
    file_id: id,
    relative_path: path,
    title: base.replace(/\.[a-z0-9]+$/i, ''),
    format: path.split('.').pop() ?? '',
    status: 'active',
    current_revision_id: `rev_${id}`,
    last_observed_at: '2026-11-20T08:00:00.000Z',
    coverage: 'full_text',
    ...overrides,
  };
}

function reading(fileId: string, at: string): [string, ReadingState] {
  return [
    fileId,
    {
      file_id: fileId,
      last_read_revision_id: 'rev_x',
      last_section_id: '',
      last_page_number: 0,
      scrollPercent: 0.5,
      isFullyRead: false,
      bookmarked: false,
      personalNote: '',
      updated_at: at,
    },
  ];
}

function artifact(fileId: string, p0: number, p1: number): ArtifactStateView {
  return {
    file_id: fileId,
    initiative_id: 'init_1',
    current_path: `docs/${fileId}.md`,
    title: fileId,
    stage: '决策',
    state: 'draft',
    selected_revision_id: null,
    checklist_done: 0,
    checklist_total: 0,
    pending_p0: p0,
    pending_p1: p1,
    pending_p2: 0,
    last_activity_at: null,
  };
}

const FILES: PaletteFileLite[] = [
  file('f1', 'docs/登录方案.md'),
  file('f2', 'specs/架构-总览.pdf', { coverage: 'pdf_page_text' }),
  file('f3', 'assets/img/logo.png', { coverage: 'filename_only' }),
  file('f4', 'docs/网关设计.docx'),
  file('f5', 'trash/废弃.md', { status: 'trashed' }),
];

const NOW = new Date('2026-11-20T12:00:00');


test('localFileHits：关键词子串 + type/status/@日期语法过滤', () => {
  const states = Object.fromEntries([reading('f1', '2026-11-20T10:00:00Z')]);
  const hits = localFileHits(FILES, states, parsePaletteQuery('登录', NOW), [], 30);
  assert.deepEqual(hits.map((h) => h.fileId), ['f1']);

  const pdfOnly = localFileHits(FILES, states, parsePaletteQuery('type:pdf', NOW), [], 30);
  assert.deepEqual(pdfOnly.map((h) => h.fileId), ['f2']);

  const artifacts = [artifact('f1', 1, 0), artifact('f2', 0, 2)];
  const pending = localFileHits(FILES, states, parsePaletteQuery('status:待拍板', NOW), artifacts, 30);
  assert.deepEqual(pending.map((h) => h.fileId).sort(), ['f1', 'f2']);
  assert.equal(pending[0].pendingDecisions, 1);

  const yesterday = localFileHits(FILES, states, parsePaletteQuery('@昨天', NOW), [], 30);
  assert.deepEqual(yesterday, []);
  const today = localFileHits(FILES, states, parsePaletteQuery('@今天', NOW), [], 30);
  assert.equal(today.length, 4);

  const all = localFileHits(FILES, states, parsePaletteQuery('', NOW), [], 30);
  assert.ok(all.every((h) => h.fileId !== 'f5'));
});

test('serverHitsToItems + mergeHits：服务端优先、同 file_id 去重', () => {
  const srv: SearchHitDto[] = [
    {
      file_id: 'f9',
      revision_id: 'rev_f9',
      relative_path: 'notes/正文命中.md',
      title: '正文命中',
      format: 'md',
      coverage: 'full_text',
      match_strategy: 'bigram_phrase_verified',
      locator: { kind: 'lines', start: 3, end: 3 },
      snippet: '第 3 行出现登录网关结论',
      score: 15,
      stale: false,
    },
    {
      file_id: 'f1',
      revision_id: 'rev_f1',
      relative_path: 'docs/登录方案.md',
      title: '登录方案',
      format: 'md',
      coverage: 'full_text',
      match_strategy: 'exact_code',
      locator: { kind: 'lines', start: 6, end: 6 },
      snippet: '验收标准引用 AC-03 编号',
      score: 15,
      stale: false,
    },
  ];
  const local: PaletteItem[] = serverHitsToItems([], 30);
  const localHit: PaletteItem = {
    kind: 'file',
    key: 'local:f1',
    title: '登录方案',
    subtitle: 'docs/登录方案.md',
    fileId: 'f1',
    revisionId: 'rev_f1',
    relativePath: 'docs/登录方案.md',
    score: 40,
  };
  const merged = mergeHits(serverHitsToItems(srv, 30), [localHit, ...local], 30);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].key, 'srv:f1:rev_f1');
  assert.equal(merged[1].key, 'srv:f9:rev_f9');
  assert.ok(merged.every((m) => !m.key.startsWith('local:')), '同 file_id 本地条目被服务端覆盖');
});

test('recentViewedItems：updated_at 最新优先 Top N，未读不出', () => {
  const states = Object.fromEntries([
    reading('f1', '2026-11-19T09:00:00Z'),
    reading('f2', '2026-11-20T11:00:00Z'),
  ]);
  const recents = recentViewedItems(FILES, states, 20);
  assert.equal(recents.length, 2);
  assert.equal(recents[0].fileId, 'f2', '最近读的排最前');
  assert.equal(recents[0].kind, 'file');
  const one = recentViewedItems(FILES, states, 1);
  assert.deepEqual(one.map((r) => r.fileId), ['f2']);
});

test('builtinActions：常驻动作与工作区切换行', () => {
  const actions = builtinActions(['H:\\a\\登录方案', 'H:\\b\\网关']);
  assert.equal(actions[0].actionId, 'jump-today');
  assert.equal(actions[1].actionId, 'open-basket');
  assert.equal(actions[2].actionId, 'locate-root');
  const ws = actions.filter((a) => a.actionId === 'switch-workspace');
  assert.equal(ws.length, 2);
  assert.equal(ws[0].payload, 'H:\\a\\登录方案');
  assert.ok(ws[0].title.includes('登录方案'), '标题取目录尾段');
});

test('assemblePaletteResults：空态=最近浏览+动作；查询态=语法过滤合并', () => {
  const states = Object.fromEntries([reading('f1', '2026-11-20T10:00:00Z')]);
  const initiatives: InitiativeStateView[] = [
    {
      initiative_id: 'init_1',
      name: '登录方案专项',
      root_dir: 'docs',
      current_stage: '决策',
      state: 'draft',
      artifact_count: 1,
      pending_p0: 0,
      pending_p1: 0,
      pending_p2: 0,
      updated_at: '2026-11-20T00:00:00Z',
    },
  ];
  const artifacts = [artifact('f1', 1, 0)];

  const empty = assemblePaletteResults({
    query: parsePaletteQuery('', NOW),
    files: FILES,
    readingStates: states,
    serverItems: [],
    initiatives,
    artifacts,
    recentWorkspaces: ['H:\\a\\登录方案'],
    limit: 30,
  });
  assert.equal(empty[0].kind, 'file');
  assert.equal(empty[0].fileId, 'f1');
  assert.ok(empty.some((i) => i.kind === 'action'));

  const inQuery = assemblePaletteResults({
    query: parsePaletteQuery('in:登录方案专项', NOW),
    files: FILES,
    readingStates: states,
    serverItems: [],
    initiatives,
    artifacts,
    recentWorkspaces: [],
    limit: 30,
  });
  assert.deepEqual(inQuery.map((i) => i.fileId), ['f1']);

  const none = assemblePaletteResults({
    query: parsePaletteQuery('in:不存在事项', NOW),
    files: FILES,
    readingStates: states,
    serverItems: [],
    initiatives,
    artifacts,
    recentWorkspaces: [],
    limit: 30,
  });
  assert.deepEqual(none, []);
});
