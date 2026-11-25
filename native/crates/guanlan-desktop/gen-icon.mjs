// 生成桌面壳图标源图（1024×1024 RGBA PNG）：司辰翼漏银匣徽。
// 视觉母题与配色直承司辰原画（public/assets/aistudio/image_85bd7b05.png）与观澜纸墨气质：
// - 透明底三层圆角文件夹廓形（占满画布 90% 宽度，无外框压迫感与外溢暗影）：
//   深曜石缎面灰蓝折耳与前袋（微带星雾斜光与 1px 冷银倒角，明暗任务栏下均立体分明）；
// - 左上折耳嵌饰司辰权杖同款精钢朱砂核心眼（点睛收束折耳重心）；
// - 前后板夹层露出一道温润象牙纸页折边，强化「本地档案工作台」层次且令 16px 折耳清晰可辨；
// - 前板正中满比例嵌饰司辰标志性的「弧形拉丝银翼 + 车削铂银玻璃沙漏 + 朱砂琥珀流沙」，
//   佐以极克制的表盘星轨暗纹，16px 到 1024px 均辨识度十足且不拥挤发糊。
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
const mix3 = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 四角半径可分上下设定的圆角矩形 SDF（上左/上右用 rTop，下左/下右用 rBot） */
function sdRoundedBoxTopBot(px, py, bx, by, rTop, rBot) {
  const r = py < 0 ? rTop : rBot;
  return sdRoundedBox(px, py, bx, by, r);
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

/**
 * 弧形羽刃 SDF（二次贝塞尔骨架 + 两端收尖、中段丰润的羽片厚度轮廓）。
 * 相比直线胶囊，能自然还原司辰羽翼上扬微拱、羽尖清隽的雕塑感。
 */
function sdCurvedFeather(px, py, p0x, p0y, p1x, p1y, p2x, p2y, rRoot, rMid, rTip) {
  // 8 段折线逼近二次贝塞尔，在羽翼尺度下远小于半像素误差且速度极快
  let bestD = 1e9;
  let bestT = 0;
  let bestSignedY = 0;
  let prevX = p0x;
  let prevY = p0y;
  const STEPS = 10;
  for (let i = 1; i <= STEPS; i++) {
    const t1 = i / STEPS;
    const mt1 = 1 - t1;
    const curX = mt1 * mt1 * p0x + 2 * mt1 * t1 * p1x + t1 * t1 * p2x;
    const curY = mt1 * mt1 * p0y + 2 * mt1 * t1 * p1y + t1 * t1 * p2y;

    const pax = px - prevX;
    const pay = py - prevY;
    const bax = curX - prevX;
    const bay = curY - prevY;
    const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay + 1e-9), 0, 1);
    const t = ((i - 1) + h) / STEPS;
    const qx = prevX + bax * h;
    const qy = prevY + bay * h;
    const dist = Math.hypot(px - qx, py - qy);
    // 羽片宽度：根部窄、中后段（t≈0.62）饱满、羽尖利落收细
    const profile =
      t < 0.62
        ? mix(rRoot, rMid, smoothstep(0.0, 0.62, t))
        : mix(rMid, rTip, Math.pow((t - 0.62) / 0.38, 1.35));
    const d = dist - profile;
    if (d < bestD) {
      bestD = d;
      bestT = t;
      bestSignedY = (py - qy) / (profile + 1e-4);
    }
    prevX = curX;
    prevY = curY;
  }
  return { d: bestD, t: bestT, ridge: bestSignedY };
}

/** 司辰对称双翼（三层紧密叠合的弧形羽刃，贴合司辰肩后银翼比例） */
function evalChronosWings(hx, hy) {
  const ax = Math.abs(hx);
  // 粗筛包围盒，非羽翼区直接跳过曲线求值，兼顾 4×4 MSAA 渲染速度
  if (ax < 0.08 || ax > 0.80 || hy < -0.34 || hy > 0.30) {
    return null;
  }
  // 主翼长羽（上扬微拱、羽尖舒展）
  const f1 = sdCurvedFeather(ax, hy, 0.14, 0.00, 0.43, -0.22, 0.71, -0.17, 0.030, 0.060, 0.011);
  // 中翼次羽（紧贴主羽下缘顺势展开）
  const f2 = sdCurvedFeather(ax, hy, 0.14, 0.05, 0.38, -0.06, 0.59, -0.01, 0.026, 0.050, 0.010);
  // 下翼短羽（收拢托底，收束双翼轮廓）
  const f3 = sdCurvedFeather(ax, hy, 0.14, 0.09, 0.31, 0.07, 0.45, 0.14, 0.022, 0.038, 0.009);
  return { f1, f2, f3, d: Math.min(f1.d, f2.d, f3.d) };
}

// 文件夹几何骨架：参照 Windows 11 Fluent 文件夹比例，加一层夹页纸张形成精致三层厚度
const TAB_X0 = -0.28;
const TAB_X1 = 0.04;
const BACK_TAB_Y = -0.75;
const BACK_SHOULDER_Y = -0.51;
const FOLDER_HALF_W = 0.90;
const FOLDER_BOT_Y = 0.78;
const PAPER_TOP_Y = -0.445;
const PAPER_HALF_W = 0.818;
const FRONT_TOP_Y = -0.375;
const FRONT_CY = (FRONT_TOP_Y + FOLDER_BOT_Y) * 0.5; // +0.2025
const FRONT_HALF_H = (FOLDER_BOT_Y - FRONT_TOP_Y) * 0.5; // 0.5775

function backTopY(x) {
  return mix(BACK_TAB_Y, BACK_SHOULDER_Y, smoothstep(TAB_X0, TAB_X1, x));
}

function backTopSlope(x) {
  if (x <= TAB_X0 || x >= TAB_X1) return 0;
  const u = (x - TAB_X0) / (TAB_X1 - TAB_X0);
  return ((BACK_SHOULDER_Y - BACK_TAB_Y) * 6 * u * (1 - u)) / (TAB_X1 - TAB_X0);
}

/** 文件夹后板（含左上折耳）精确 SDF：无拼接鼓包，四角为标准圆弧 */
function sdFolderBack(x, y) {
  const rTL = 0.14;
  const rTR = 0.125;
  const rBot = 0.15;

  if (x < -FOLDER_HALF_W + rTL && y < BACK_TAB_Y + rTL) {
    return Math.hypot(x - (-FOLDER_HALF_W + rTL), y - (BACK_TAB_Y + rTL)) - rTL;
  }
  if (x > FOLDER_HALF_W - rTR && y < BACK_SHOULDER_Y + rTR) {
    return Math.hypot(x - (FOLDER_HALF_W - rTR), y - (BACK_SHOULDER_Y + rTR)) - rTR;
  }
  if (x < -FOLDER_HALF_W + rBot && y > FOLDER_BOT_Y - rBot) {
    return Math.hypot(x - (-FOLDER_HALF_W + rBot), y - (FOLDER_BOT_Y - rBot)) - rBot;
  }
  if (x > FOLDER_HALF_W - rBot && y > FOLDER_BOT_Y - rBot) {
    return Math.hypot(x - (FOLDER_HALF_W - rBot), y - (FOLDER_BOT_Y - rBot)) - rBot;
  }
  const dLeft = -FOLDER_HALF_W - x;
  const dRight = x - FOLDER_HALF_W;
  const dBot = y - FOLDER_BOT_Y;
  const dTop = (backTopY(x) - y) / Math.hypot(1, backTopSlope(x));
  return Math.max(dLeft, dRight, dTop, dBot);
}

/** 文件夹夹层象牙纸页 SDF（仅在前袋上沿与后板之间露出清脆纸边） */
function sdPaperSheet(x, y) {
  return sdRoundedBox(x, y - 0.02, PAPER_HALF_W, 0.465, 0.064);
}

/** 文件夹前袋面板 SDF */
function sdFolderFront(x, y) {
  return sdRoundedBoxTopBot(x, y - FRONT_CY, FOLDER_HALF_W, FRONT_HALF_H, 0.105, 0.15);
}

// 司辰琉璃沙漏弧线：宽肩丰润、细腰挺拔
function hourglassHalfWidth(y, H, wCap, wWaist) {
  const u = clamp(Math.abs(y) / H, 0, 1);
  const c = clamp(Math.pow(u, 1.48) * (2.1 - 1.1 * Math.pow(u, 0.85)), 0, 1);
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

function blendOverPremul(dst, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a;
  dst[0] = dst[0] * ia + r * a;
  dst[1] = dst[1] * ia + g * a;
  dst[2] = dst[2] * ia + b * a;
  dst[3] = dst[3] * ia + a;
}

function blendOnOpaque(col, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a;
  col[0] = col[0] * ia + r * a;
  col[1] = col[1] * ia + g * a;
  col[2] = col[2] * ia + b * a;
}

function addGlow(col, r, g, b, a) {
  if (a <= 0) return;
  col[0] = Math.min(255, col[0] + r * a);
  col[1] = Math.min(255, col[1] + g * a);
  col[2] = Math.min(255, col[2] + b * a);
}

/** 司辰权杖核心眼：精钢铂银镶口 + 暗凹槽 + 暖朱砂琥珀宝珠（带左上微星点高光） */
function drawChronosTabEye(col, x, y, gx, gy, rOuter, rGem) {
  const dOuter = sdCircle(x, y, gx, gy, rOuter);
  const bezelA = smoothstep(AA, -AA, dOuter);
  if (bezelA > 0) {
    const bt = clamp((y - (gy - rOuter)) / (2 * rOuter), 0, 1);
    const bc = mix3([242, 245, 252], [156, 165, 188], bt);
    blendOnOpaque(col, bc[0], bc[1], bc[2], bezelA * 0.96);
  }
  blendOnOpaque(col, 14, 17, 26, smoothstep(AA, -AA, sdCircle(x, y, gx, gy, rOuter * 0.72)) * 0.96);
  const gA = smoothstep(AA, -AA, sdCircle(x, y, gx, gy, rGem));
  if (gA > 0) {
    const gd = clamp(Math.hypot(x - (gx - rGem * 0.30), y - (gy - rGem * 0.30)) / (rGem * 1.45), 0, 1);
    const gc = mix3([255, 204, 140], [212, 70, 36], gd);
    blendOnOpaque(col, gc[0], gc[1], gc[2], gA);
    // 左上晶点微高光
    const specA = smoothstep(AA, -AA, sdCircle(x, y, gx - rGem * 0.32, gy - rGem * 0.32, rGem * 0.24));
    blendOnOpaque(col, 255, 248, 236, specA * 0.72);
  }
}

function sampleIcon(x, y) {
  // 0. 透明外廓：绝不烘培外溢阴影，由系统任务栏自行绘投影
  const dBack = sdFolderBack(x, y);
  const dPaper = sdPaperSheet(x, y);
  const dFront = sdFolderFront(x, y);
  const out = [0, 0, 0, 0];

  // 1. 后板 + 左上折耳（深曜石灰蓝 + 司辰权杖朱砂核心眼）
  const backA = smoothstep(AA, -AA, dBack);
  if (backA > 0.001) {
    const bt = clamp((y - BACK_TAB_Y) / (FRONT_TOP_Y - BACK_TAB_Y + 0.35), 0, 1);
    const bCol = mix3([50, 56, 72], [26, 30, 41], bt);
    // 折耳顶缘冷银细倒角
    const dBackRim = Math.abs(dBack + 0.011) - 0.0068;
    const topRimMask = smoothstep(-0.38, -0.74, y);
    blendOnOpaque(bCol, 158, 168, 198, smoothstep(AA, -AA, dBackRim) * topRimMask * 0.36);
    // 夹层纸页上沿落到后板的微影
    const crease = smoothstep(-0.50, PAPER_TOP_Y + 0.01, y) * 0.28;
    blendOnOpaque(bCol, 10, 12, 18, crease);
    // 司辰权杖朱砂核心眼（镶于折耳左中位，呼应流沙暖色与司辰身份）
    drawChronosTabEye(bCol, x, y, -0.56, -0.595, 0.066, 0.038);
    blendOverPremul(out, bCol[0], bCol[1], bCol[2], backA);
  }

  // 2. 夹层温润象牙纸页（赋予档案工作台的纸墨质感，并令暗底任务栏下折耳与前板层次分明）
  const paperA = smoothstep(AA, -AA, dPaper) * smoothstep(AA, -AA, dBack);
  if (paperA > 0.001 && y < FRONT_TOP_Y + 0.04) {
    const pt = clamp((y - PAPER_TOP_Y) / 0.095, 0, 1);
    const pCol = mix3([245, 241, 234], [204, 207, 218], pt);
    const fLipSh = smoothstep(FRONT_TOP_Y - 0.042, FRONT_TOP_Y + 0.005, y) * 0.32;
    blendOnOpaque(pCol, 22, 26, 38, fLipSh);
    const pRim = smoothstep(PAPER_TOP_Y + 0.020, PAPER_TOP_Y, y) * 0.45;
    blendOnOpaque(pCol, 255, 253, 249, pRim);
    blendOverPremul(out, pCol[0], pCol[1], pCol[2], paperA);
  }

  // 3. 前袋面板（曜石缎面灰蓝 + 星雾斜光 + 蚀刻表盘暗环 + 精密冷银倒角边）
  const frontA = smoothstep(AA, -AA, dFront);
  if (frontA > 0.001) {
    const fy = clamp((y - FRONT_TOP_Y) / (FOLDER_BOT_Y - FRONT_TOP_Y), 0, 1);
    const fx = clamp((x + FOLDER_HALF_W) / (2 * FOLDER_HALF_W), 0, 1);
    const diag = clamp(fy * 0.72 + fx * 0.28, 0, 1);
    const fCol = mix3([62, 69, 90], [22, 26, 37], diag);

    // 宽幅柔和斜向缎面漫反射（承司辰羽翼一丝薰衣草冷银光泽）
    const sheenBand = Math.exp(-Math.pow((x * 0.65 + (y - FRONT_CY) * 0.75 + 0.36) / 0.56, 2));
    addGlow(fCol, 166, 158, 218, sheenBand * 0.14);

    // 居中微弱朱砂暖晕
    const hx = x;
    const hy = y - FRONT_CY;
    const hr = Math.hypot(hx, hy);
    addGlow(fCol, 244, 124, 70, Math.exp(-hr * hr * 6.8) * 0.14);

    // 极克制的曜石表盘星轨蚀刻暗环（大尺寸呈钟表雕刻感，16px 下零干扰）
    const dDialRing = Math.abs(hr - 0.445) - 0.0042;
    blendOnOpaque(fCol, 184, 194, 226, smoothstep(AA * 1.4, -AA * 1.4, dDialRing) * 0.13);

    // 精密 CNC 冷银外细边 + 顶缘折边高光 + 底缘收暗
    const dOuterEdge = Math.abs(dFront + 0.011) - 0.0068;
    const outerEdgeA = smoothstep(AA, -AA, dOuterEdge);
    blendOnOpaque(fCol, 134, 144, 174, outerEdgeA * 0.25);
    const topHi = smoothstep(FRONT_TOP_Y + 0.072, FRONT_TOP_Y, y);
    blendOnOpaque(fCol, 198, 206, 232, outerEdgeA * topHi * 0.48);
    const botShade = smoothstep(FOLDER_BOT_Y - 0.095, FOLDER_BOT_Y, y) * 0.38;
    blendOnOpaque(fCol, 10, 12, 19, botShade);

    // 4. 司辰对称弧形拉丝银翼（自沙漏腰后向两侧舒展，不挤压沙漏本体）
    const wings = evalChronosWings(hx, hy);
    const wingsSh = evalChronosWings(hx, hy - 0.032);
    if (wingsSh) {
      blendOnOpaque(fCol, 8, 10, 16, smoothstep(0.044, -0.014, wingsSh.d) * 0.44);
    }
    if (wings) {
      // 原画同款极轻薰衣草冷辉贴着羽翼外沿浮现
      addGlow(
        fCol,
        178,
        158,
        236,
        Math.exp(-Math.max(wings.d, 0) * 20) * smoothstep(0.055, -0.015, wings.d - 0.045) * 0.16
      );

      // 由下到上三层叠加：下短羽 -> 中次羽 -> 上主羽，每片带明暗羽脊立体感
      const feathers = [
        { f: wings.f3, hi: [164, 170, 192], lo: [96, 104, 128] },
        { f: wings.f2, hi: [198, 204, 224], lo: [120, 128, 152] },
        { f: wings.f1, hi: [236, 240, 250], lo: [146, 154, 178] },
      ];
      for (const item of feathers) {
        // 每片羽刃下方投落一丝叠层缝影，让三层羽毛层次如浮雕银饰
        blendOnOpaque(fCol, 12, 15, 24, smoothstep(0.026, -0.004, item.f.d) * 0.34);
        const fa = smoothstep(AA, -AA, item.f.d);
        if (fa > 0) {
          // 羽刃上沿受光亮银、下沿微暗，外端羽尖略提亮
          const ridgeLight = clamp(0.55 - item.f.ridge * 0.45, 0, 1);
          const lit = clamp(ridgeLight * 0.65 + item.f.t * 0.35, 0, 1);
          const fc = mix3(item.lo, item.hi, lit);
          blendOnOpaque(fCol, fc[0], fc[1], fc[2], fa * 0.96);
        }
      }
    }

    // 5. 居中满比例司辰沙漏（拉丝铂银端盖与廓线 + 烟熏玻璃腔 + 司辰朱砂琥珀流沙）
    const H = 0.338;
    const wCap = 0.262;
    const wWaist = 0.046;
    const capW = wCap + 0.068;
    const capH = 0.043;

    // 沙漏压在双翼之上的立体落影，立刻确立主次层级
    const shY = hy - 0.032;
    const dTotalSh = Math.min(
      sdHourglassBody(hx, shY, H, wCap + 0.024, wWaist + 0.018),
      sdRoundedBox(hx, shY + H + capH * 0.45, capW, capH, capH),
      sdRoundedBox(hx, shY - H - capH * 0.45, capW, capH, capH)
    );
    blendOnOpaque(fCol, 8, 10, 16, smoothstep(0.058, -0.018, dTotalSh) * 0.56);

    const dGlass = sdHourglassBody(hx, hy, H, wCap, wWaist);
    const glassFillA = smoothstep(AA, -AA, dGlass);
    if (glassFillA > 0) {
      blendOnOpaque(fCol, 14, 17, 26, glassFillA * 0.94);
      const leftGlass = smoothstep(0.04, -0.22, hx) * smoothstep(0.04, 0.30, Math.abs(hy));
      addGlow(fCol, 215, 228, 252, leftGlass * 0.14 * glassFillA);
    }

    // 司辰朱砂琥珀流沙
    const dCavity = sdHourglassBody(hx, hy, H - 0.008, wCap - 0.036, wWaist - 0.012);
    const cavityMask = smoothstep(AA, -AA, dCavity);
    if (cavityMask > 0) {
      const topSurface = -0.195 + 0.040 * Math.exp(-(hx * hx) / 0.018);
      const upperMask = smoothstep(-AA, AA, hy - topSurface) * smoothstep(AA, -AA, hy - 0.012);
      const moundSurface = 0.095 + 1.04 * hx * hx + 0.12 * Math.abs(hx);
      const lowerMask = smoothstep(-AA, AA, hy - moundSurface);
      const dStream = sdSegment(hx, hy, 0, -0.015, 0, 0.118) - 0.0155;
      const streamMask = smoothstep(AA, -AA, dStream);
      const streamHi = streamMask * smoothstep(0.122, 0.065, hy);

      const sandA = clamp(Math.max(upperMask, lowerMask, streamMask), 0, 1) * cavityMask;
      if (sandA > 0) {
        const st = clamp((hy + 0.21) / 0.55, 0, 1);
        const sCol = mix3([255, 166, 108], [212, 78, 42], st);
        const topHi2 = Math.exp(-Math.pow((hy - topSurface) / 0.028, 2)) * upperMask * 0.44;
        const boost = clamp(streamHi * 0.56 + Math.exp(-(hx * hx) / 0.024) * 0.12 + topHi2, 0, 0.80);
        const fin = mix3(sCol, [255, 218, 166], boost);
        blendOnOpaque(fCol, fin[0], fin[1], fin[2], sandA);
      }
    }

    // 琉璃内壁贴弧高光
    if (hx < -0.05 && hy > -0.28 && hy < -0.07) {
      const dInnerSpec = Math.abs(dGlass + 0.046) - 0.008;
      const arcFade = smoothstep(-0.28, -0.22, hy) * smoothstep(-0.07, -0.13, hy);
      blendOnOpaque(fCol, 255, 255, 255, smoothstep(AA, -AA, dInnerSpec) * arcFade * 0.38);
    }

    // 拉丝铂银玻璃廓线
    const dGlassStroke = Math.abs(dGlass) - 0.024;
    const strokeA = smoothstep(AA, -AA, dGlassStroke);
    if (strokeA > 0) {
      const gt2 = clamp((hy + H) / (2 * H), 0, 1);
      const fc = mix3([246, 247, 251], [176, 183, 200], gt2);
      blendOnOpaque(fCol, fc[0], fc[1], fc[2], strokeA * 0.98);
    }

    // 上下车削铂银端盖
    const dTopCap = sdRoundedBox(hx, hy + H + capH * 0.45, capW, capH, capH);
    const dBotCap = sdRoundedBox(hx, hy - H - capH * 0.45, capW, capH, capH);
    const dCaps = Math.min(dTopCap, dBotCap);
    const capsA = smoothstep(AA, -AA, dCaps);
    if (capsA > 0) {
      const isTop = dTopCap < dBotCap;
      const localY = isTop ? hy + H + capH * 0.45 : hy - H - capH * 0.45;
      const vt = clamp((localY + capH) / (2 * capH), 0, 1);
      const cc = mix3([250, 251, 254], [158, 166, 186], vt);
      const capTopHi = smoothstep(-capH * 0.15, -capH * 0.85, localY) * 0.35;
      blendOnOpaque(cc, 255, 255, 255, capTopHi);
      blendOnOpaque(fCol, cc[0], cc[1], cc[2], capsA);
    }

    // 细腰温润微光
    const dWaist = Math.hypot(hx, hy);
    addGlow(fCol, 255, 198, 136, Math.exp(-dWaist * dWaist * 150) * 0.28);

    blendOverPremul(out, fCol[0], fCol[1], fCol[2], frontA);
  }

  if (out[3] <= 1e-4) return [0, 0, 0, 0];
  return [
    clamp(out[0] / out[3], 0, 255),
    clamp(out[1] / out[3], 0, 255),
    clamp(out[2] / out[3], 0, 255),
    clamp(out[3] * 255, 0, 255),
  ];
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
