/**
 * 观澜 v0.4 —— 单次对账脚本（手动重扫入口）
 *
 * 用法：
 *   npx tsx scripts/v04-reconcile-once.ts [工作区根目录]
 *
 * 只读扫描工作区，把版本、事件与证据写入持久库（%LOCALAPPDATA%/Guanlan/workspaces/<rootKey>）。
 * 连续执行不会重复增加事件；内容未变的文件只更新采集状态。
 */

import path from 'node:path';
import { reconcileWorkspace } from '../server/reconcile';
import { projectWorkspace } from '../server/project';
import { eventTimeRange } from '../server/queries';
import { defaultDataDir } from '../server/WorkspaceStore';

const root = process.argv[2] || process.env.GUANLAN_WORKSPACE_ROOT || 'C:/Users/34689/Downloads/拥抱AI';

const started = Date.now();
const { report, store } = reconcileWorkspace(root, {});
const state = projectWorkspace(store, root);
const range = eventTimeRange(store, report.workspaceId);
const counts = store.counts(report.workspaceId);

console.log('工作区：', path.resolve(root));
console.log('数据目录：', defaultDataDir(root));
console.log('');
console.log('本次对账：');
console.log(`  扫描 ${report.scanned} 份（MD ${report.byFormat.md} / SVG ${report.byFormat.svg} / PDF ${report.byFormat.pdf}）`);
console.log(`  基线扫描：${report.initialBaseline ? '是' : '否'}`);
console.log(`  新文件 ${report.newFiles} · 新版本 ${report.newRevisions} · 内容修改 ${report.contentChanged}`);
console.log(`  未变 ${report.unchanged} · 仅 mtime ${report.mtimeOnly} · 缺失 ${report.missing} · 恢复 ${report.recovered}`);
console.log(`  事件新增 ${report.eventsInserted} · 跳过 ${report.eventsSkipped}`);
console.log(`  陈述 ${report.statementsUpserted} · 引用 ${report.edgesUpserted}`);
console.log(`  快照新写 ${report.snapshotsWritten} 个 · 不稳定读取 ${report.unstableReads}`);
console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('');
console.log('持久库累计：');
console.log(`  文件 ${counts.files} · 版本 ${counts.revisions} · 事件 ${counts.events} · 快照 ${counts.blobs}`);
console.log(`  陈述 ${counts.statements} · 引用 ${counts.edges}`);
console.log(`  事件发生时间：${range.occurredMin ?? '—'} → ${range.occurredMax ?? '—'}（日期待考 ${range.undatedCount}）`);
console.log(`  采集时间：${range.observedMin ?? '—'} → ${range.observedMax ?? '—'}`);
console.log('');
console.log('投影：', state.scanDiagnostics.durationHint);

store.close();
