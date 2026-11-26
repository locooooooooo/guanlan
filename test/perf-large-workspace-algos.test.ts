import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeReadingIslandStats,
  computeReadingIslandSummary,
} from '../src/utils/readingIslandStats';
import { minimalDirPrefix } from '../src/utils/documentIdentity';
import { groupFilesIntoPackages } from '../src/utils/taskPackages';
import {
  buildMergedFolderTree,
  collectMergedFolderOptions,
  computeSiblingSharedPrefixMap,
} from '../src/utils/sidebarTree';
import type { FileRecord, ReadingState } from '../src/types/guanlan';

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
);

function makeSyntheticFile(
  id: string,
  folder: string,
  title: string,
  format: FileRecord['format'] = 'jpg',
  snapshotAvailable = true
): FileRecord {
  const relativePath = folder ? `${folder}/${title}` : title;
  const revId = `rev_${id}`;
  return {
    file_id: id,
    relative_path: relativePath,
    title,
    format,
    folder: folder || '.',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revId,
    coverage: 'filename_only',
    revisions: [
      {
        revision_id: revId,
        versionNumber: 1,
        observed_at: '2026-11-24T10:00:00Z',
        sizeBytes: 35000,
        snapshotAvailable,
      },
    ],
  } as unknown as FileRecord;
}

test('computeReadingIslandStats 重名目录前缀与 minimalDirPrefix 逐条等价，且汇总口径同源', () => {
  const files: FileRecord[] = [
    makeSyntheticFile('f1', 'runs/run-A/sub', '001.jpg', 'jpg', true),
    makeSyntheticFile('f2', 'runs/run-B/sub', '001.jpg', 'jpg', false),
    makeSyntheticFile('f3', 'other/sub', '001.jpg', 'jpg', true),
    makeSyntheticFile('f4', '', '001.jpg', 'jpg', true),
    makeSyntheticFile('f5', 'docs/same', 'spec.md', 'md', true),
    makeSyntheticFile('f6', 'docs/same', 'spec.svg', 'svg', true),
    makeSyntheticFile('f7', 'unique/dir', 'solo.md', 'md', true),
  ];
  files[4].title = 'spec';
  files[5].title = 'spec';

  const readingStates: Record<string, ReadingState> = {
    f1: {
      file_id: 'f1',
      last_read_revision_id: 'rev_f1',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: false,
      updated_at: '2026-11-24T12:00:00Z',
    },
  };

  const stats = computeReadingIslandStats(files, readingStates);
  const summary = computeReadingIslandSummary(files, readingStates);

  assert.deepEqual(summary, {
    total: stats.total,
    read: stats.read,
    unread: stats.unread,
    persisted: stats.persisted,
  });

  const pathsByTitle = new Map<string, string[]>();
  for (const f of files) {
    const list = pathsByTitle.get(f.title);
    if (list) list.push(f.relative_path);
    else pathsByTitle.set(f.title, [f.relative_path]);
  }
  const byId = new Map(stats.entries.map((e) => [e.fileId, e]));
  for (const f of files) {
    const expected = minimalDirPrefix(f.relative_path, pathsByTitle.get(f.title) ?? []);
    assert.equal(byId.get(f.file_id)?.dirPrefix, expected, `路径 ${f.relative_path} 前缀须一致`);
  }
});

test('ReadingIsland 顶栏收起态仅走轻量汇总，排序热路径复用 Intl.Collator 禁每比较重建', () => {
  const islandUi = fs.readFileSync(path.join(ROOT, 'src/components/ReadingIsland.tsx'), 'utf8');
  assert.ok(islandUi.includes('computeReadingIslandSummary(files, readingStates)'));
  assert.ok(islandUi.includes('expanded ? computeReadingIslandStats(files, readingStates) : null'));

  const islandStats = fs.readFileSync(path.join(ROOT, 'src/utils/readingIslandStats.ts'), 'utf8');
  assert.ok(islandStats.includes('new Intl.Collator('));
  assert.ok(!islandStats.includes('.localeCompare('));

  const pkgSrc = fs.readFileSync(path.join(ROOT, 'src/utils/taskPackages.ts'), 'utf8');
  assert.ok(pkgSrc.includes('new Intl.Collator(undefined, { numeric: true })'));
  assert.ok(!pkgSrc.includes("localeCompare(b.title, undefined, { numeric: true })"));

  const treeSrc = fs.readFileSync(path.join(ROOT, 'src/utils/sidebarTree.ts'), 'utf8');
  assert.ok(treeSrc.includes("new Intl.Collator('zh-Hans-CN')"));
  assert.ok(!treeSrc.includes(".localeCompare("));
});

test('大工作区同名文件与深层目录算法保持线性量级（12,000 份文件无二次方退化）', () => {
  const files: FileRecord[] = [];
  let seq = 0;
  for (let d = 0; d < 120; d += 1) {
    const folder = `02_工程/辩论赛/第${(d % 12) + 1}期/assets/roles/dir_${String(d).padStart(3, '0')}`;
    for (let i = 0; i < 100; i += 1) {
      seq += 1;
      files.push(makeSyntheticFile(`f_${seq}`, folder, `${String(i + 1).padStart(3, '0')}.jpg`));
    }
  }

  const tIsland = performance.now();
  const stats = computeReadingIslandStats(files, {});
  const dtIsland = performance.now() - tIsland;
  assert.equal(stats.total, 12000);
  assert.ok(dtIsland < 800, `computeReadingIslandStats(12000) 耗时 ${dtIsland.toFixed(1)}ms 过高`);

  const tPkg = performance.now();
  const pkgs = groupFilesIntoPackages(files);
  const dtPkg = performance.now() - tPkg;
  assert.equal(pkgs.length, 1);
  assert.equal(pkgs[0].docs.length, 12000);
  assert.ok(dtPkg < 800, `groupFilesIntoPackages(12000) 耗时 ${dtPkg.toFixed(1)}ms 过高`);

  const tTree = performance.now();
  const tree = buildMergedFolderTree(files, []);
  const options = collectMergedFolderOptions(files, []);
  const prefixes = computeSiblingSharedPrefixMap(
    Array.from({ length: 100 }, (_, i) => `${String(i + 1).padStart(3, '0')}.jpg`)
  );
  const dtTree = performance.now() - tTree;
  assert.equal(tree.nodes.length, 1);
  assert.ok(options.length > 100);
  assert.equal(prefixes.size, 100);
  assert.ok(dtTree < 500, `sidebarTree(12000) 耗时 ${dtTree.toFixed(1)}ms 过高`);
});
