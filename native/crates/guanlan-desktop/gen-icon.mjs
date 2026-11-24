// 生成桌面壳图标源图（1024×1024 RGBA PNG）：司辰星盘沙漏徽。
// 视觉母题直承司辰立绘（public/assets/aistudio/image_85bd7b05.png）：
// - 澜墨星夜圆角琉璃底（#112030 为核 + 薰衣草星雾 + 琥珀暖晕 + 微涟漪）
// - 银白新月星盘环（左厚右纤的书法弧，零硬折痕）
// - 12 点司辰权杖指针尖与琥珀核心珠（与银环一体铸成）
// - 居中琉璃沙漏与暖琥珀流沙（上仓漏斗 + 细流 + 下仓沉淀丘）
// - 3 点四芒星芒与 6 点锚点，平衡左右视觉重心
//
// 纯 Node 实现（zlib 内置），无第三方依赖；4×4 MSAA 抗锯齿。
// 改样式后在仓库根运行：
//   node native/crates/guanlan-desktop/gen-icon.mjs
//   npx --no-install tauri icon native/crates/guanlan-desktop/app-icon.png -o native/crates/guanlan-desktop/icons
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 1024;
const AA = 2.0 / SIZE;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;
  const pq0x = v0x - e0x * clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y), 0, 1);
  const pq0y = v0y - e0y * clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y), 0, 1);
  const pq1x = v1x - e1x * clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y), 0, 1);
  const pq1y = v1y - e1y * clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y), 0, 1);
  const pq2x = v2x - e2x * clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y), 0, 1);
  const pq2y = v2y - e2y * clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y), 0, 1);
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(
    pq0x * pq0x + pq0y * pq0y,
    pq1x * pq1x + pq1y * pq1y,
    pq2x * pq2x + pq2y * pq2y
  );
  const inside = Math.min(
    s * (v0x * e0y - v0y * e0x),
    s * (v1x * e1y - v1y * e1x),
    s * (v2x * e2y - v2y * e2x)
  );
  return -Math.sqrt(d) * Math.sign(inside);
}

// 琉璃沙漏弧线：宽肩收腰，贴合司辰左手沙漏比例
function hourglassHalfWidth(y, H, wCap, wWaist) {
  const u = clamp(Math.abs(y) / H, 0, 1);
  const c = clamp(Math.pow(u, 1.55) * (2.2 - 1.2 * Math.pow(u, 0.85)), 0, 1);
  const sm = u * u * (3 - 2 * u);
  const blend = mix(sm, Math.sin(u * Math.PI * 0.5), 0.25);
  return mix(wWaist, wCap, mix(blend, c, 0.25));
}

function sdHourglassBody(lx, ly, H, wCap, wWaist) {
  const absY = Math.abs(ly);
  const w = hourglassHalfWidth(ly, H, wCap, wWaist);
  const dx = Math.abs(lx) - w;
  const dy = absY - H;
  if (dy <= 0) {
    const eps = 0.004;
    const w2 = hourglassHalfWidth(Math.min(absY + eps, H), H, wCap, wWaist);
    const slope = (w2 - w) / eps;
    return dx / Math.hypot(1, slope);
  }
  return Math.hypot(Math.max(dx, 0), dy);
}

function sdStar4(px, py, cx, cy, r) {
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  const p = 0.54;
  const v = Math.pow(Math.pow(dx / r + 1e-6, p) + Math.pow(dy / r + 1e-6, p), 1 / p);
  return (v - 1) * r * 0.52;
}

// 书法感新月星盘环：左侧 9 点为丰润新月，经 12/6 点平滑过渡为右侧 3 点纤细星轨
function sdCrescentOrbit(x, y, rOut, maxW, minW) {
  const r = Math.hypot(x, y);
  const dOut = r - rOut;
  const cosT = r > 1e-6 ? x / r : 0;
  const u = (1 - cosT) * 0.5;
  const thickness = mix(minW, maxW, Math.pow(u, 1.35));
  const dIn = rOut - thickness - r;
  return Math.max(dOut, dIn);
}

function blendOver(dst, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a;
  dst[0] = dst[0] * ia + r * a;
  dst[1] = dst[1] * ia + g * a;
  dst[2] = dst[2] * ia + b * a;
}

function addGlow(dst, r, g, b, a) {
  if (a <= 0) return;
  dst[0] = Math.min(255, dst[0] + r * a);
  dst[1] = Math.min(255, dst[1] + g * a);
  dst[2] = Math.min(255, dst[2] + b * a);
}

function sampleIcon(x, y) {
  // 1. 圆角方徽底（占画布 94%，Windows 任务栏 / 标题栏下体量饱满）
  const dBg = sdRoundedBox(x, y, 0.94, 0.94, 0.43);
  const bgAlpha = smoothstep(AA, -AA, dBg);
  if (bgAlpha <= 0.001) return [0, 0, 0, 0];

  // 澜墨深空底色（#1C2846 -> #0C1627）
  const gt = clamp((x * 0.35 + y * 0.65 + 1) * 0.5, 0, 1);
  const col = [mix(28, 11, gt), mix(40, 21, gt), mix(70, 39, gt)];

  // 薰衣草星雾（左上，呼应司辰羽翼与界面交互色）+ 琥珀暖晕（居中，托起流沙）
  const r0 = Math.hypot(x, y);
  const dIris = Math.hypot((x + 0.22) * 0.9, (y + 0.24) * 0.9);
  addGlow(col, 124, 111, 212, Math.exp(-dIris * dIris * 2.1) * 0.36);
  addGlow(col, 245, 134, 66, Math.exp(-r0 * r0 * 5.2) * 0.34);

  // 外圈极轻水纹星轨（保留「观澜」一脉相承的静水意象）
  const dOuterRipple = Math.abs(r0 - 0.835) - 0.0038;
  blendOver(col, 214, 228, 252, smoothstep(AA * 1.5, -AA * 1.5, dOuterRipple) * 0.09);

  // 琉璃内沿高光折边
  const dRim = Math.abs(dBg + 0.014) - 0.009;
  const rimGrad = smoothstep(0.65, -0.75, y * 0.8 + x * 0.3);
  blendOver(col, 244, 248, 255, smoothstep(AA, -AA, dRim) * mix(0.06, 0.24, rimGrad));

  // 主徽微微下沉 0.03，给 12 点司辰指针留足天头呼吸
  const cx = x;
  const cy = y - 0.03;

  // 2. 银白新月星盘环 + 12 点司辰权杖指针（一体铸银，无缝衔接）
  const rOut = 0.72;
  const dRing = sdCrescentOrbit(cx, cy, rOut, 0.155, 0.029);

  const fy = -0.688;
  const dSpearTop = sdTriangle(cx, cy, 0, -0.892, -0.068, fy + 0.012, 0.068, fy + 0.012);
  const dSpearBot = sdTriangle(cx, cy, 0, fy + 0.092, -0.044, fy - 0.004, 0.044, fy - 0.004);
  const dCollar = sdCircle(cx, cy, 0, fy, 0.066);
  const dFinial = Math.min(dSpearTop, dSpearBot, dCollar);

  const ringA = smoothstep(AA, -AA, dRing);
  if (ringA > 0) {
    const r = Math.hypot(cx, cy);
    const cosT = r > 1e-6 ? cx / r : 0;
    const leftFactor = (1 - cosT) * 0.5;
    const topFactor = clamp((-cy + rOut) / (2 * rOut), 0, 1);
    const bright = clamp(0.45 * leftFactor + 0.55 * topFactor, 0, 1);
    const alphaMod = mix(0.64, 1.0, smoothstep(0.05, 0.55, leftFactor));
    blendOver(
      col,
      mix(196, 252, bright),
      mix(210, 253, bright),
      mix(244, 255, bright),
      ringA * alphaMod
    );
  }

  const finialA = smoothstep(AA, -AA, dFinial);
  if (finialA > 0) {
    // 指针左右微切面反光，立体如钟表精钢指针
    const facet = cx < 0 ? 1.0 : 0.9;
    blendOver(col, 252 * facet, 253 * facet, 255, finialA);
  }

  // 权杖指针核心暗凹槽 + 暖琥珀宝珠（司辰右手权杖标志细节）
  const dGemSocket = sdCircle(cx, cy, 0, fy, 0.041);
  blendOver(col, 14, 23, 40, smoothstep(AA, -AA, dGemSocket) * 0.94);
  const dGem = sdCircle(cx, cy, 0, fy, 0.0315);
  const gemA = smoothstep(AA, -AA, dGem);
  if (gemA > 0) {
    const gd = clamp(Math.hypot(cx + 0.009, cy - (fy - 0.009)) / 0.038, 0, 1);
    blendOver(col, mix(255, 224, gd), mix(190, 86, gd), mix(110, 36, gd), gemA);
  }

  // 3 点四芒星芒（与左侧厚新月形成视觉平衡，呼应全景星图）
  const sx = 0.705;
  const sy = 0.0;
  const dStarGlow = Math.hypot(cx - sx, cy - sy);
  addGlow(col, 255, 222, 175, Math.exp(-dStarGlow * dStarGlow * 55) * 0.42);
  blendOver(col, 255, 248, 238, smoothstep(AA, -AA, sdStar4(cx, cy, sx, sy, 0.095)));

  // 6 点微锚点
  blendOver(col, 230, 240, 255, smoothstep(AA, -AA, sdStar4(cx, cy, 0, 0.7, 0.052)) * 0.86);

  // 3. 居中琉璃沙漏（司辰左手流沙漏）
  const H = 0.395;
  const wCap = 0.275;
  const wWaist = 0.042;
  const dGlass = sdHourglassBody(cx, cy, H, wCap, wWaist);
  const glassFillA = smoothstep(AA, -AA, dGlass);
  if (glassFillA > 0) {
    blendOver(col, 12, 22, 40, glassFillA * 0.84);
    const leftGlass = smoothstep(0.02, -0.22, cx) * smoothstep(0.04, 0.34, Math.abs(cy));
    addGlow(col, 210, 232, 255, leftGlass * 0.2 * glassFillA);
  }

  // 沙漏内腔与暖琥珀流沙
  const dCavity = sdHourglassBody(cx, cy, H - 0.026, wCap - 0.04, wWaist - 0.011);
  const cavityMask = smoothstep(AA, -AA, dCavity);
  if (cavityMask > 0) {
    // 上仓流沙（约 62% 满，带中央微凹漏斗面）
    const topSurface = -0.245 + 0.036 * Math.exp(-(cx * cx) / 0.016);
    const upperMask = smoothstep(-AA, AA, cy - topSurface) * smoothstep(AA, -AA, cy - 0.014);
    // 下仓沉淀丘
    const moundSurface = 0.125 + 0.92 * cx * cx + 0.14 * Math.abs(cx);
    const lowerMask = smoothstep(-AA, AA, cy - moundSurface);
    // 细腰流沙金线（落入下仓沙丘顶点处柔顺融色，不留胶囊硬边）
    const dStream = sdSegment(cx, cy, 0, -0.02, 0, 0.145) - 0.0175;
    const streamMask = smoothstep(AA, -AA, dStream);
    const streamHighlight = streamMask * smoothstep(0.148, 0.085, cy);

    const sandA = clamp(Math.max(upperMask, lowerMask, streamMask), 0, 1) * cavityMask;
    if (sandA > 0) {
      const st = clamp((cy + 0.26) / 0.65, 0, 1);
      const centerLum = Math.exp(-(cx * cx) / 0.025);
      const topHighlight = Math.exp(-Math.pow((cy - topSurface) / 0.032, 2)) * upperMask * 0.45;
      let sr = mix(255, 222, st);
      let sg = mix(174, 86, st);
      let sb = mix(90, 38, st);
      const boost = clamp(streamHighlight * 0.55 + centerLum * 0.18 + topHighlight, 0, 0.85);
      sr = mix(sr, 255, boost);
      sg = mix(sg, 224, boost);
      sb = mix(sb, 150, boost);
      blendOver(col, sr, sg, sb, sandA);
    }
  }

  // 琉璃内壁贴弧高光（沿左上玻璃肩曲线弯曲）
  if (cx < -0.05 && cy > -0.34 && cy < -0.09) {
    const dInnerSpec = Math.abs(dGlass + 0.044) - 0.008;
    const arcFade = smoothstep(-0.34, -0.27, cy) * smoothstep(-0.09, -0.15, cy);
    blendOver(col, 255, 255, 255, smoothstep(AA, -AA, dInnerSpec) * arcFade * 0.42);
  }

  // 沙漏银白玻璃廓线
  const dGlassStroke = Math.abs(dGlass) - 0.019;
  const strokeA = smoothstep(AA, -AA, dGlassStroke);
  if (strokeA > 0) {
    const gt2 = clamp((cy + H) / (2 * H), 0, 1);
    blendOver(col, mix(248, 212, gt2), mix(251, 224, gt2), mix(255, 244, gt2), strokeA * 0.94);
  }

  // 上下银白端盖（带微立体渐变）
  const capW = wCap + 0.064;
  const capH = 0.042;
  const dTopCap = sdRoundedBox(cx, cy + H + capH * 0.48, capW, capH, capH);
  const dBotCap = sdRoundedBox(cx, cy - H - capH * 0.48, capW, capH, capH);
  const dCaps = Math.min(dTopCap, dBotCap);
  const capsA = smoothstep(AA, -AA, dCaps);
  if (capsA > 0) {
    const isTop = dTopCap < dBotCap;
    const localY = isTop ? cy + H + capH * 0.48 : cy - H - capH * 0.48;
    const vt = clamp((localY + capH) / (2 * capH), 0, 1);
    blendOver(col, mix(255, 206, vt), mix(255, 218, vt), mix(255, 240, vt), capsA);
  }

  // 细腰暖金微辉
  const dWaist = Math.hypot(cx, cy);
  addGlow(col, 255, 205, 125, Math.exp(-dWaist * dWaist * 130) * 0.55);

  return [col[0], col[1], col[2], bgAlpha * 255];
}

// 4×4 MSAA 渲染 1024×1024 RGBA 像素缓冲
const px = new Uint8Array(SIZE * SIZE * 4);
const SUB = [-0.375, -0.125, 0.125, 0.375];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < 4; sy++) {
      const ny = ((y + 0.5 + SUB[sy]) / SIZE) * 2 - 1;
      for (let sx = 0; sx < 4; sx++) {
        const nx = ((x + 0.5 + SUB[sx]) / SIZE) * 2 - 1;
        const s = sampleIcon(nx, ny);
        const wa = s[3] / 255;
        r += s[0] * wa;
        g += s[1] * wa;
        b += s[2] * wa;
        a += wa;
      }
    }
    const i = (y * SIZE + x) * 4;
    if (a > 1e-4) {
      px[i] = Math.round(clamp(r / a, 0, 255));
      px[i + 1] = Math.round(clamp(g / a, 0, 255));
      px[i + 2] = Math.round(clamp(b / a, 0, 255));
      px[i + 3] = Math.round(clamp((a / 16) * 255, 0, 255));
    }
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
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
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
