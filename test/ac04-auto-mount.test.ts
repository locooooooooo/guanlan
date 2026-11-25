/**
 * 智能体上下文三入口默认包「默认自动勾选」接线测试。
 *
 * 验收口径：从任意页面打开上下文清单抽屉时，默认上下文包应在
 * 抽屉首帧即已勾选（典型工作区已选 ≥2），不再要求用户先点「带入默认上下文」，
 * 也不再出现「一键复制上下文清单 (0 项已选)」。
 *
 * 覆盖：
 *  ① App 所有打开入口复用 openContextDrawer：先 handleMountPointers(presetPointers)
 *     再 setIsContextDrawerOpen(true)（同批提交，首帧即 N 项）；
 *  ② 抽屉自身兜底 useEffect（数据晚到/未来入口绕过 openContextDrawer 时补挂）；
 *  ③ 抽屉 SSR：默认包已挂载时显示「默认上下文已自动带入」且复制按钮计数为 N，
 *     不再是 0 项空态。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { AgentContextDrawer } from '../src/components/ModalsAndDrawers';
import type { EvidencePointer } from '../src/types/guanlan';

const stripComments = (html: string): string => html.replace(/<!--.*?-->/g, '');

function pointer(fileId: string, path: string): EvidencePointer {
  return {
    file_id: fileId,
    revision_id: `rev_${fileId}`,
    relative_path: path,
    content_sha256: '',
    locator: { kind: 'file' },
    evidence_kind: 'metadata_only',
    index_generation: 1,
    observed_at: '2026-11-18T00:00:00+08:00',
    coverage: 'full_text',
    stale: false,
    excerpt: '',
    granularity: 'full',
    sizeBytes: 0,
  };
}

const presets = [
  pointer('f_ac04_doc', '04-智能体代码/README.md'),
  pointer('f_ac04_plan', '04-智能体代码/PLAN.md'),
];

test('上下文抽屉 SSR：默认包已挂载时首帧显示已自动带入，复制计数 ≥2', () => {
  const html = stripComments(
    renderToString(
      createElement(AgentContextDrawer, {
        isOpen: true,
        onClose: () => {},
        pointers: presets,
        onRemovePointer: () => {},
        onClearPointers: () => {},
        workspaceRoot: 'H:/ws',
        intent: 'document',
        intentTemplate: '基于当前方案文档与未决约束，推进下一阶段执行/代码实现',
        presetPointers: presets,
        recommendedMounts: [],
        onMountPointers: () => {},
        onUpdatePointerGranularity: () => {},
        confirmedDecisions: [],
        pendingBlockers: [],
        decisionChangeNote: null,
      })
    )
  );

  assert.ok(html.includes('data-preset-auto-mounted'), '自动带入状态标记存在');
  assert.ok(
    html.includes('默认上下文已自动带入（2 项已选）'),
    '默认包状态显示 2 项已自动勾选'
  );
  assert.ok(
    html.includes('一键复制上下文清单 (2 项已选)'),
    '复制按钮首帧计数为 2（不是 0）'
  );
  assert.ok(
    !html.includes('一键复制上下文清单 (0 项已选)'),
    '不得再出现 0 项已选空态'
  );
});

test('上下文抽屉接线：所有打开入口先挂载默认包再打开抽屉；抽屉保留晚到补挂兜底', () => {
  // 拆层后 App 实现 = 装配层 + 单一 Store + 分节组件——联合文本断言（语义不变）
  const app = ['../src/App.tsx', '../src/stores/useWorkspaceStore.tsx', '../src/components/app/AppBanners.tsx', '../src/components/app/AppMainViews.tsx', '../src/components/app/AppLibraryStage.tsx', '../src/components/app/AppModalsStack.tsx']
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
    .join(String.fromCharCode(10))
  assert.match(app, /const openContextDrawer = useCallback/, 'App 提供统一打开入口');
  assert.match(
    app,
    /if \(presetPointers\.length > 0\) handleMountPointers\(presetPointers\);/,
    '打开前先挂载预设条目'
  );
  assert.match(app, /onOpenContextDrawer=\{openContextDrawer\}/, '顶栏入口复用统一打开函数');
  assert.equal(
    (app.match(/setIsContextDrawerOpen\(true\)/g) || []).length,
    1,
    '唯一直接置 true 应只在 openContextDrawer 内'
  );
  assert.ok(
    (app.match(/openContextDrawer\(\)/g) || []).length >= 5,
    '所有打开入口（顶栏/证据篮/回写通知等）统一走 openContextDrawer'
  );

  // 拆解 ModalsAndDrawers 后，AgentContextDrawer 实现位于 components/modals/AgentContextDrawer.tsx
  const drawer = [
    '../src/components/ModalsAndDrawers.tsx',
    '../src/components/modals/AgentContextDrawer.tsx',
  ]
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
    .join('\n');
  assert.match(drawer, /autoMountedRef/, '抽屉有每开周期一次的自动补挂守卫');
  assert.match(drawer, /onMountPointers\(presetPointers\)/, '晚到数据补挂通道');
  assert.match(drawer, /data-preset-auto-mounted/, '自动带入状态标记');
  assert.match(drawer, /默认上下文已自动带入/, '自动带入状态文案');
});
