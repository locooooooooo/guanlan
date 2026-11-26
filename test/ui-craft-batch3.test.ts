import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { computeSafeTrunkEndY, TRUNK_DOCK_CLEARANCE_PX } from '../src/components/graph/geometry';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
}

test('纸面模式舷窗独立锁定浅底高对比墨色，严禁在 html.dark 下继承白字导致白底白字', () => {
  const css = readSrc('index.css');
  const start = css.indexOf(".dark-porthole[data-canvas-theme='xray-light'] {");
  assert.ok(start >= 0, 'index.css 必须声明 xray-light 纸面块');
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);

  for (const prop of [
    '--cv-ink:',
    '--cv-ink-2:',
    '--cv-ink-3:',
    '--cv-ink-muted:',
    '--cv-ink-meta:',
    '--cv-seg-active-bg:',
    '--cv-seg-active-ink:',
    '--cv-on-brand:',
  ]) {
    const m = block.match(new RegExp(`${prop}\\s*([^;]+);`));
    assert.ok(m, `xray-light 块缺少 ${prop}`);
    assert.ok(
      !m[1].includes('var(--ink-') && !m[1].includes('var(--paper-on-ink)'),
      `${prop} 不得继承随 html.dark 反转的壳层变量（现值 ${m[1]}）`
    );
    assert.match(m[1], /^#[0-9a-fA-F]{6}/, `${prop} 须锁定明确浅底十六进制色值`);
  }

  assert.ok(block.includes('--ink-strong: #26243D;'), '纸面舷窗须锁定内部 --ink-strong');
  assert.ok(block.includes('--foreground: #26243D;'), '纸面舷窗须锁定内部 --foreground');
  assert.ok(block.includes('--card: #FFFFFF;'), '纸面舷窗须锁定内部 --card');
});

test('星图主干空档断层标注右置避让司辰立绘，且底部主干按舞台高度预留 Dock 安全区', () => {
  const trunkSrc = readSrc('components/graph/GraphSceneTrunk.tsx');
  const gapStart = trunkSrc.indexOf('if (tick.isGap)');
  const gapEnd = trunkSrc.indexOf('if (tick.isTruncation)', gapStart);
  assert.ok(gapStart >= 0 && gapEnd > gapStart);
  const gapBlock = trunkSrc.slice(gapStart, gapEnd);

  assert.ok(gapBlock.includes('data-trunk-gap-label={tick.date}'), '断层标注需带可测锚点');
  assert.ok(gapBlock.includes('x={trunkX + 16}'), '断层底板胶囊须置于主干右侧避开左侧司辰');
  assert.ok(!gapBlock.includes('x={trunkX - 18}'), '断层文字不得再放在主干左侧撞司辰立绘');

  assert.equal(computeSafeTrunkEndY(0), 640, 'SSR 无舞台高度时回退安全底界 640');
  assert.equal(computeSafeTrunkEndY(956), 640, '高屏保持上限 640，节奏紧凑');
  assert.equal(computeSafeTrunkEndY(776), 640, '1440×900 舞台为底部 Dock 留足安全净距');
  assert.equal(
    computeSafeTrunkEndY(676),
    676 - TRUNK_DOCK_CLEARANCE_PX,
    '1200×800 矮舞台自动收紧主干底界防 Dock 遮挡'
  );
  assert.equal(computeSafeTrunkEndY(560), 500, '极矮窗口保底 500 不压扁主干');

  const ctrlSrc = readSrc('components/graph/useGraphCanvasController.tsx');
  assert.ok(ctrlSrc.includes('computeSafeTrunkEndY(stageHeight)'), '主干底界须走 computeSafeTrunkEndY');
  assert.ok(!ctrlSrc.includes('const trunkEndY = 710;'), '不得再硬编码 710 穿透底部 Dock');
});

test('首页焦点卡斜叠微卡具备纵向净距与克制展角，防重叠与暗色边缘融合', () => {
  const motionCss = readSrc('styles/motion.css');
  assert.ok(motionCss.includes('rotate(-1.8deg)'), '前景微卡静息倾角克制在 -1.8deg');
  assert.ok(motionCss.includes('rotate(1.8deg)'), '后景微卡静息倾角克制在 +1.8deg');
  assert.ok(!motionCss.includes('rotate(8deg)'), '悬停展角不得过大导致容器裁切');

  const cardsSrc = readSrc('components/FeaturedFocusCards.tsx');
  assert.ok(cardsSrc.includes('h-[132px] w-[212px]'), '决策焦点微卡舞台高度预留防重叠净距');
  assert.ok(cardsSrc.includes("layer === 0 ? 'h-[70px] px-3 py-2' : 'h-[44px] px-3 py-1.5'"), '上下微卡定高留出纵向呼吸');
  assert.ok(cardsSrc.includes('bg-popover/95'), '深色模式下悬浮微卡与外卡具备明确表面阶差');
});
