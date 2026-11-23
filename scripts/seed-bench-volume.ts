/**
 * B05 · 10,000 份混合文件标准压测夹具生成器（纯文件系统写入，不建库）
 *
 * 用法：
 *   npx tsx scripts/seed-bench-volume.ts <输出根目录> [--total 10000] [--clean]
 *
 * 产出（默认配比，合计恰为 --total）：
 *   docs/     MD 2,800（约 1/14 带 [P1 - 待确认] 决策标记 + 跨文件链接，驱动派生管线）
 *   src/      代码 2,800（ts/js/py/rs/go 循环）
 *   assets/   PNG 2,000（合法最小 PNG 头 + 随机尾，走魔数/尺寸探测路径）
 *   specs/    PDF 800（2~6 页文本，驱动 B04 页级抽取重路径）
 *   docs/     DOCX 400（合法最小 OOXML：[Content_Types]+rels+document.xml）
 *   sheets/   XLSX 400（合法最小 OOXML：workbook+sharedStrings+sheet1）
 *   archives/ ZIP 400（stored 无压缩 zip）
 *   data/     CSV 195（RFC-4180）+ JSON 200
 *   media/    大二进制 ×5（50MiB+1B，超默认配额线 → 仅记身份不复制快照）
 *   scratch/  50 份（被 .gitignore 忽略，不入库）
 *   node_modules/ 30 份（DEFAULT_EXCLUDED 黑名单，不入库）
 *
 * 纪律：与 smoke-v1.ts 同源——刻意不 import 任何 guanlan/server 实现；
 * mtime 用 utimesSync 分散在 2026-09-01 ~ 2026-11-18；内容用固定种子 LCG，
 * 可复跑可复现；文件内容全量唯一（SHA-256 去重零命中，如实压测快照写入）。
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('用法：npx tsx scripts/seed-bench-volume.ts <输出根目录> [--total 10000] [--clean]');
  process.exit(1);
}
const totalArgIdx = process.argv.indexOf('--total');
const TOTAL = totalArgIdx >= 0 ? Number(process.argv[totalArgIdx + 1] || 10000) : 10000;
const CLEAN = process.argv.includes('--clean');
const WS_ROOT = root;
const TARGET = path.resolve(root);
const mt = (p: string, iso: string): void => {
  // Node 24 / Windows：utimesSync 必须传 Date 对象（number 时间戳触发 EINVAL -4071）
  const d = new Date(iso);
  fs.utimesSync(p, d, d);
};

// ---------- 确定性伪随机（LCG，seed 固定可复现） ----------
let lcgState = 42;
const rnd = (): number => {
  lcgState = (lcgState * 1103515245 + 12345) % 2147483648;
  return lcgState / 2147483648;
};
const rndInt = (max: number): number => Math.floor(rnd() * max);
const pad = (n: number, w: number): string => String(n).padStart(w, '0');

// mtime 分散窗口：2026-09-01 ~ 2026-11-18（79 天）
const DAY0 = Date.UTC(2026, 8, 1);
const DAY_SPAN_MS = 78 * 24 * 3600 * 1000;
const dayIso = (i: number): string => {
  const dayIdx = i % 79;
  return new Date(DAY0 + (dayIdx * DAY_SPAN_MS) / 78).toISOString();
};

const written: string[] = [];
function putFile(rel: string, content: Buffer | string, mtimeIso: string): void {
  const target = path.join(WS_ROOT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  mt(target, mtimeIso);
  written.push(rel);
}

// ---------- CRC-32（zip/PNG 需要；查表实现） ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- stored ZIP 构造（无压缩；条目均为 UTF-8 文本） ----------
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x5941, 12); // date (2026-09-01 附近，非零即可)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x5941, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------- 最小合法 PNG（1x1 灰度）+ 随机尾填充 ----------
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 1x1 灰度：IHDR + IDAT(0x78 0x9C 预置 + 原始 filter+pixel 的 deflate 固定哈夫曼流) + IEND
const IHDR = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
const IDAT = pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]));
const IEND = pngChunk('IEND', Buffer.alloc(0));
function buildPng(padBytes: number): Buffer {
  const tail = Buffer.alloc(padBytes);
  for (let i = 0; i < padBytes; i++) tail[i] = rndInt(256);
  return Buffer.concat([PNG_SIG, IHDR, IDAT, IEND, tail]);
}

// ---------- 最小多页文本 PDF（B04 页级抽取真实负载） ----------
function buildPdf(pages: number, tag: string): Buffer {
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const fontObj = 3 + pages * 2;
  const kids: string[] = [];
  objects.push('PLACEHOLDER_PAGES');
  for (let p = 1; p <= pages; p++) {
    const pageObj = 3 + (p - 1) * 2;
    const contObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contObj} 0 R >>`
    );
    const body = `BT /F1 12 Tf 72 720 Td (${tag} Section Page ${p} of ${pages}) Tj ET`;
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- 最小合法 OOXML（docx / xlsx） ----------
const OOXML_CT = (defaults: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}</Types>`;
const OOXML_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function buildDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return buildStoredZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        OOXML_CT(
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        )
      ),
    },
    { name: '_rels/.rels', data: Buffer.from(OOXML_RELS) },
    { name: 'word/document.xml', data: Buffer.from(doc) },
  ]);
}

function buildXlsx(sheetName: string, rows: string[][]): Buffer {
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheetRows = rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${v}</v></c>`)
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  return buildStoredZip([
    { name: '[Content_Types].xml', data: Buffer.from(ct) },
    { name: '_rels/.rels', data: Buffer.from(rels) },
    { name: 'xl/workbook.xml', data: Buffer.from(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRels) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
  ]);
}

// ---------- 内容生成器（全部唯一：tag 含路径序号 + 伪随机填充行） ----------
const filler = (i: number, n: number, w: number): string => {
  const lines: string[] = [];
  for (let k = 0; k < n; k++) lines.push(`<!-- filler ${i}-${k} ${'x'.repeat(8 + rndInt(w))} -->`);
  return lines.join('\n');
};

function mdDoc(rel: string, i: number, pdfTotal: number): string {
  const withDecision = i % 14 === 0;
  const lines = [
    `# 基准样本文档 ${i}`,
    '',
    `文档日期：${dayIso(i).slice(0, 10)}`,
    '',
    `本文件是 B05 体量基准的合成样本：${rel}。`,
    `填充校验串：${'ab'.repeat(16)}（第 ${i} 号）`,
  ];
  if (withDecision) {
    lines.push(
      '',
      `[P1 - 待确认] 样本 ${i} 的冻结窗口是否按 30 天执行？`,
      '',
      `推荐及理由：按 ${10 + (i % 20)} 天滚动窗口执行。`,
      '',
      `依据：[规范](../specs/基准-规范-${pad(i % Math.max(1, pdfTotal), 5)}.pdf#page=${1 + (i % 6)})`
    );
  }
  lines.push('', filler(i, 8, 40));
  return lines.join('\n');
}

const CODE_EXTS = ['ts', 'js', 'py', 'rs', 'go'] as const;
function codeDoc(i: number): string {
  const ext = CODE_EXTS[i % CODE_EXTS.length];
  const n = 40 + rndInt(60);
  const lines: string[] = [`// bench sample ${i} (${ext})`];
  for (let k = 0; k < n; k++) {
    lines.push(`export const sample_${i}_${k} = ${rndInt(1 << 20)}; // ${'x'.repeat(rndInt(24))}`);
  }
  return lines.join('\n');
}

function csvDoc(i: number): string {
  const rows: string[] = ['item,qty,price'];
  for (let k = 0; k < 32; k++) {
    rows.push(`SKU-${pad(i, 4)}-${pad(k, 2)},${1 + rndInt(9)},${(rnd() * 100).toFixed(2)}`);
  }
  return rows.join('\n');
}

function jsonDoc(i: number): string {
  return JSON.stringify(
    {
      id: `bench-${i}`,
      day: dayIso(i).slice(0, 10),
      metrics: Array.from({ length: 24 }, () => rndInt(1000)),
      note: 'B05 体量基准合成样本（内容唯一）',
    },
    null,
    2
  );
}

// ---------- 主流程 ----------
if (CLEAN) {
  fs.rmSync(TARGET, { recursive: true, force: true });
}
fs.mkdirSync(WS_ROOT, { recursive: true });

console.log(`B05 夹具生成：${TARGET}（目标 ${TOTAL} 个可见文件）`);
const t0 = Date.now();

// 配比（合计 = TOTAL）：按比例缩放到任意 total
const RATIO: Array<[string, number]> = [
  ['md', 2800],
  ['code', 2800],
  ['png', 2000],
  ['pdf', 800],
  ['docx', 400],
  ['xlsx', 400],
  ['zip', 400],
  ['csv', 195],
  ['json', 200],
  ['big', 5],
];
const ratioSum = RATIO.reduce((s, [, n]) => s + n, 0);
const scale = TOTAL / ratioSum;
const counts = RATIO.map(([k, n]) => [k, Math.max(k === 'big' ? 1 : 1, Math.round(n * scale))] as const);
// 修平误差到最大族（md）
const diff = TOTAL - counts.reduce((s, [, n]) => s + n, 0);
counts[0] = ['md', (counts[0][1] as number) + diff];

let seq = 0;
const nextIso = (): string => dayIso(seq++);

// 预解构各族数量（缩放取整后由 md 族修平 TOTAL 误差）
const mdCount = counts[0][1];
const codeCount = counts[1][1];
const pngCount = counts[2][1];
const pdfCount = counts[3][1];
const docxCount = counts[4][1];
const xlsxCount = counts[5][1];
const zipCount = counts[6][1];
const csvIdx = counts.findIndex(([k]) => k === 'csv');
const jsonIdx = counts.findIndex(([k]) => k === 'json');
const csvCount = csvIdx >= 0 ? counts[csvIdx][1] : 195;
const jsonCount = jsonIdx >= 0 ? counts[jsonIdx][1] : 200;
const bigCount = counts.find(([k]) => k === 'big')?.[1] ?? 5;

// 1) docs MD（决策标记引用的 PDF 按 pdf 实际数量取模，保证链接可解析）
for (let i = 0; i < mdCount; i++) {
  const rel = `docs/基准-文档-${pad(i, 5)}.md`;
  putFile(rel, mdDoc(rel, i, pdfCount), nextIso());
}
console.log(`  docs MD ×${mdCount}`);

// 2) src 代码
for (let i = 0; i < codeCount; i++) {
  const ext = CODE_EXTS[i % CODE_EXTS.length];
  putFile(`src/模块${i % 40}/sample_${pad(i, 5)}.${ext}`, codeDoc(i), nextIso());
}
console.log(`  src 代码 ×${codeCount}`);

// 3) assets PNG
for (let i = 0; i < pngCount; i++) {
  putFile(`assets/img/图样-${pad(i, 5)}.png`, buildPng(6 * 1024 + rndInt(2048)), nextIso());
}
console.log(`  assets PNG ×${pngCount}`);

// 4) specs PDF
for (let i = 0; i < pdfCount; i++) {
  const pages = 2 + (i % 5);
  putFile(
    `specs/基准-规范-${pad(i, 5)}.pdf`,
    buildPdf(pages, `Bench Spec ${pad(i, 5)}`),
    nextIso()
  );
}
console.log(`  specs PDF ×${pdfCount}`);

// 5) docs DOCX
for (let i = 0; i < docxCount; i++) {
  const paras = Array.from({ length: 6 }, (_, k) => `基准方案 ${pad(i, 5)} · 第 ${k + 1} 段（${'内容'.repeat(6)}）`);
  putFile(`docs/方案/基准-方案-${pad(i, 5)}.docx`, buildDocx(paras), nextIso());
}
console.log(`  docs DOCX ×${docxCount}`);

// 6) sheets XLSX
for (let i = 0; i < xlsxCount; i++) {
  const rows = Array.from({ length: 12 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => String(rndInt(5000) + c))
  );
  putFile(`sheets/基准-台账-${pad(i, 5)}.xlsx`, buildXlsx(`台账${i % 9}`, rows), nextIso());
}
console.log(`  sheets XLSX ×${xlsxCount}`);

// 7) archives ZIP
for (let i = 0; i < zipCount; i++) {
  putFile(
    `archives/基准-归档-${pad(i, 5)}.zip`,
    buildStoredZip([
      { name: `readme-${i}.txt`, data: Buffer.from(`B05 归档样本 ${i}\n${'z'.repeat(256)}`) },
      { name: `data-${i}.csv`, data: Buffer.from(csvDoc(i)) },
    ]),
    nextIso()
  );
}
console.log(`  archives ZIP ×${zipCount}`);

// 8) data CSV + JSON
for (let i = 0; i < csvCount; i++) {
  putFile(`data/表样-${pad(i, 5)}.csv`, csvDoc(i), nextIso());
}
for (let i = 0; i < jsonCount; i++) {
  putFile(`data/指标-${pad(i, 5)}.json`, jsonDoc(i), nextIso());
}
console.log(`  data CSV ×${csvCount} · JSON ×${jsonCount}`);

// 9) media 大二进制（>50MiB 配额线 → 仅记身份与哈希，绝不复制快照）
const BIG_BYTES = 50 * 1024 * 1024 + 1;
for (let i = 0; i < bigCount; i++) {
  const buf = Buffer.alloc(BIG_BYTES);
  // 首尾 64KiB 写入确定性变化字节（中段保持零 → 写盘与哈希仍真实）
  for (let k = 0; k < 65536; k++) {
    buf[k] = (i * 131 + k) % 256;
    buf[buf.length - 1 - k] = (i * 17 + k) % 256;
  }
  putFile(`media/大素材-${pad(i, 3)}.bin`, buf, nextIso());
}
console.log(`  media 大二进制 ×${bigCount}（${(BIG_BYTES / 1024 / 1024).toFixed(0)}MiB each）`);

// 10) .gitignore + 被忽略目录（不计入可见数）
const ignoreList = ['scratch/', 'tmp-build/', '!keep.md'];
putFile('.gitignore', ignoreList.join('\n') + '\n', dayIso(0));
for (let i = 0; i < 50; i++) {
  putFile(`scratch/ignored-${pad(i, 3)}.md`, `# 被忽略 ${i}\n`, nextIso());
}
for (let i = 0; i < 30; i++) {
  putFile(`node_modules/pkg-${i}/index.js`, `// vendored ${i}\n`, nextIso());
}
console.log('  .gitignore + scratch/(50) + node_modules/(30)（忽略与黑名单，不入库）');

const visible = written.length - 80 - 1; // 减去忽略/黑名单 80 份与 .gitignore 本身
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`完成：写入 ${written.length} 份（可见约 ${visible} / 目标 ${TOTAL}）· 耗时 ${elapsed}s`);
if (Math.abs(visible - TOTAL) > 2) {
  console.error(`警告：可见文件数 ${visible} 与目标 ${TOTAL} 偏差超过 ±2，请检查配比。`);
  process.exit(1);
}
