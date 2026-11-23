// 生成桌面壳图标源图（1024×1024 RGBA PNG）：深蓝圆徽 + 三圈涟漪 + 中心实点。
// 纯 Node 实现（zlib 内置），无第三方依赖；改样式后 `node gen-icon.mjs` 重新生成，
// 再 `tauri icon app-icon.png -o icons` 产出全套尺寸。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 1024;
const CX = SIZE / 2, CY = SIZE / 2;

// 涟漪：半径 / 线宽 / 不透明度
const RINGS = [
  { r: 140, w: 64, a: 1.0 },
  { r: 260, w: 54, a: 0.59 },
  { r: 380, w: 46, a: 0.31 },
];
const BG = [17, 32, 48];
const FG = [235, 245, 255];

const px = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - CX, dy = y - CY;
    const d = Math.hypot(dx, dy);
    // 圆徽底：R=496，边缘 1px 抗锯齿
    const edge = Math.min(Math.max(496.5 - d, 0), 1);
    // 涟漪环：|d - r| <= w/2，1px 抗锯齿；取不透明度最高的一圈
    let ringA = 0;
    for (const ring of RINGS) {
      const band = ring.w / 2 - 0.5;
      const cover = Math.min(Math.max(band - Math.abs(d - ring.r), 0), 1);
      ringA = Math.max(ringA, cover * ring.a);
    }
    // 中心实点
    const dot = Math.min(Math.max(52.5 - d, 0), 1);
    // 前景/底色按覆盖度混合（环与点取较强者，叠加时直接提亮）
    const fgA = Math.min(1, Math.max(ringA, dot));
    const mix = (c1, c2, t) => Math.round(c1 * (1 - t) + c2 * t);
    const i = (y * SIZE + x) * 4;
    px[i] = mix(BG[0], FG[0], fgA);
    px[i + 1] = mix(BG[1], FG[1], fgA);
    px[i + 2] = mix(BG[2], FG[2], fgA);
    px[i + 3] = Math.round(255 * edge);
  }
}

// PNG 编码：IHDR + IDAT（每行 filter 0）+ IEND，CRC32 手写
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), 'app-icon.png');
writeFileSync(out, png);
console.log(`written: ${out} (${png.length} bytes)`);
