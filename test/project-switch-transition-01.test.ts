import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectSwitchTransition } from '../src/components/app/ProjectSwitchTransition';
import {
  PROJECT_SWITCH_FEEDBACK_MIN_MS,
  remainingProjectSwitchFeedbackMs,
} from '../src/utils/projectSwitchFeedback';


function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

test('切换项目：过渡条至少亮够一段可见时长，不随请求返回就消失', () => {
  assert.equal(PROJECT_SWITCH_FEEDBACK_MIN_MS, 400);
  assert.equal(remainingProjectSwitchFeedbackMs(0), 400);
  assert.equal(remainingProjectSwitchFeedbackMs(150), 250);
  assert.equal(remainingProjectSwitchFeedbackMs(400), 0);
  assert.equal(remainingProjectSwitchFeedbackMs(900), 0);
  assert.equal(remainingProjectSwitchFeedbackMs(-5), 400);
  assert.equal(remainingProjectSwitchFeedbackMs(Number.NaN), 400);
});

test('切换项目：过渡条整层盖住窗口并把切换中的项目念出来', () => {
  const html = renderToStaticMarkup(
    createElement(ProjectSwitchTransition, { projectName: '合同台账' })
  );

  assert.ok(
    html.includes('data-project-switch-transition'),
    '过渡条要留 data 钩子，测试才能守这条接线'
  );
  assert.ok(html.includes('role="status"'), '过渡条要向读屏软件播报状态');
  assert.ok(
    html.includes('正在切换到「合同台账」'),
    '过渡条要说明正在切到哪个项目，不能只给一根光条'
  );
  assert.ok(
    html.includes('glx-switch-progress'),
    '不确定态进度段要挂动效类'
  );
  assert.ok(
    html.includes('fixed') && html.includes('inset-0'),
    '遮罩必须整层覆盖窗口，否则期间的点击会漏到底下的按钮上'
  );

  const zMatch = /z-\[(\d+)\]|z-(\d+)/.exec(html);
  assert.ok(zMatch, '过渡条要显式声明 z-index');
  const z = Number(zMatch[1] ?? zMatch[2]);
  assert.ok(z > 50, `过渡条要盖过弹层（z-50），现在 z=${z}`);
  assert.ok(z < 60, `过渡条要低于 toast（z-60），否则切换失败的提示看不见，现在 z=${z}`);
});

test('切换项目：没有项目名时也给一句中性的切换提示', () => {
  const html = renderToStaticMarkup(createElement(ProjectSwitchTransition, {}));
  assert.ok(
    html.includes('正在切换项目'),
    '拿不到项目名时不能没有提示'
  );
});

test('切换项目：过渡状态在请求之前置上、返回之后才清，并拒绝并发切换', () => {
  const hook = readSrc('hooks/useMultiProjects.ts');

  const activateStart = hook.indexOf('const handleActivateProject = useCallback');
  const activateEnd = hook.indexOf('const handleUpdateProject = useCallback');
  assert.ok(activateStart > -1 && activateEnd > activateStart, '切换处理器的源码锚点必须存在');

  const body = hook.slice(activateStart, activateEnd);
  const setIdx = body.indexOf('setActivatingProjectId(projectId)');
  const postIdx = body.indexOf('postActivateProject(projectId)');
  const clearIdx = body.indexOf('setActivatingProjectId(null)');

  assert.ok(setIdx > -1, '切换开始时要置上过渡状态');
  assert.ok(postIdx > -1, '切换处理器要发起激活请求');
  assert.ok(setIdx < postIdx, '过渡状态必须早于请求置上，否则请求期间是空窗');
  assert.ok(clearIdx > postIdx, '过渡状态必须晚于请求返回才清，否则请求一回来光条就消失');
  assert.ok(
    body.includes('remainingProjectSwitchFeedbackMs'),
    '过渡状态要按最短可见时长收尾，不能请求一回来就撤'
  );
  assert.ok(
    body.includes('if (activatingRef.current) return false;'),
    '切换进行中必须拒绝第二次切换'
  );
  assert.ok(
    body.includes('activatingRef.current = true;') && body.includes('activatingRef.current = false;'),
    '切换期间要上锁并在结束后解锁'
  );
});

test('切换项目：装配层在切换期间渲染过渡条，并把切换中的项目接给顶栏', () => {
  const app = readSrc('App.tsx');
  assert.ok(app.includes('ProjectSwitchTransition'), '装配层必须挂上过渡条');
  assert.ok(
    /switchingProjectId\s*&&\s*\(/.test(app),
    '过渡条只在切换期间出现'
  );
  assert.ok(
    app.includes('activatingProjectId={ctx.multiProjects.activatingProjectId}'),
    '顶栏要拿到切换中的项目 id'
  );

  const header = readSrc('components/TopHeader.tsx');
  assert.ok(
    header.includes('activatingProjectId'),
    '顶栏要接到切换中的项目 id'
  );
  assert.ok(
    header.includes('disabled={switchingProject}'),
    '切换期间项目下拉按钮要禁用，避免再点一次'
  );
});

test('切换项目：过渡条的动效只动 transform，reduce 下停帧仍可见', () => {
  const motion = readSrc('styles/motion.css');

  const kfStart = motion.indexOf('@keyframes glx-switch-progress');
  assert.ok(kfStart > -1, '过渡条要有自己的 keyframes');
  const kfBody = motion.slice(kfStart, motion.indexOf('}', kfStart));
  assert.ok(
    /transform:\s*translateX\(/.test(kfBody),
    '不确定态进度段靠 transform 位移'
  );
  assert.ok(
    !/width|left|top|right|height/.test(kfBody),
    '动效层只动 transform，禁布局属性'
  );

  const reduceStart = motion.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduceStart > -1, '动效层要有 reduce 降级块');
  const reduceBody = motion.slice(reduceStart);
  assert.ok(
    /\.glx-switch-progress\s*\{[^}]*animation:\s*none;[^}]*\}/.test(reduceBody),
    'reduce 下过渡条要停帧'
  );
  assert.ok(
    /\.glx-switch-progress\s*\{[^}]*display:\s*none;[^}]*\}/.test(reduceBody),
    'reduce 下扫描亮段整层隐藏'
  );
  assert.ok(
    /\.glx-switch-track\s*\{[^}]*background:[^}]*\}/.test(reduceBody),
    'reduce 下轨道要变成整条实心亮线，不能读作百分比进度'
  );
});
