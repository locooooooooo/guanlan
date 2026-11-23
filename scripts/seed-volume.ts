/**
 * 观澜 v0.4 —— 体量测试数据（仅用于验证分页与折叠组，不写入真实工程）
 *
 * 用法：
 *   npx tsx scripts/seed-volume.ts <工作区根目录> [数量=340]
 *
 * 说明：写入的是 synthetic 事件（subject_kind=decision，revision_id 为空），
 * 用于验证「超过 300 条可完整翻页」与折叠组计数；不伪造文件版本。
 */

import fs from 'node:fs';
import { WorkspaceStore, defaultDataDir } from '../server/WorkspaceStore';

const root = process.argv[2];
const total = Number(process.argv[3] || 340);
if (!root) {
  console.error('用法：npx tsx scripts/seed-volume.ts <工作区根目录> [数量]');
  process.exit(1);
}

const dataDir = defaultDataDir(root);
const store = new WorkspaceStore(dataDir);
const ws = store.ensureWorkspace(root);

const CODES = ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07'];
let inserted = 0;

store.transaction(() => {
  for (let i = 0; i < total; i++) {
    const dayIndex = i % 17;
    const date = new Date(Date.UTC(2026, 9, 20 + dayIndex)).toISOString().slice(0, 10);
    const code = CODES[i % CODES.length];
    const decisionId = `dec_volume_${code}`;
    const result = store.insertEvent({
      event_id: `evt_volume_${i}`,
      workspace_id: ws.workspace_id,
      kind: i % 3 === 0 ? 'decision_raised' : 'modified',
      subject_kind: 'decision',
      subject_id: `volume_subject_${i}`,
      revision_id: null,
      occurred_at: date,
      occurred_precision: 'day',
      occurred_source: 'document_self',
      observed_at: `${date}T09:00:${String(i % 60).padStart(2, '0')}.000Z`,
      headline: i % 3 === 0 ? `提出问题：${code} · 体量样本 ${i}` : `体量样本内容修改 ${i}`,
      detail: `体量测试事件 #${i}（不参与真实版本判定）`,
      payload_json: JSON.stringify(
        i % 3 === 0
          ? { decision_id: decisionId, code, status: '待确认', action: 'raised' }
          : { time_basis: 'collector' }
      ),
      batch_id: null,
    });
    if (result.inserted) inserted++;
  }
});

const counts = store.counts(ws.workspace_id);
console.log('工作区：', root);
console.log('数据目录：', dataDir);
console.log(`新增 synthetic 事件 ${inserted} 条`);
console.log(`累计：文件 ${counts.files} · 版本 ${counts.revisions} · 事件 ${counts.events}`);
store.close();
void fs;
