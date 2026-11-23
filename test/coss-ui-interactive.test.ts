/**
 * V02 · coss.com/ui 高阶交互原语层（Base UI）+ ReadingIsland 非遮挡 Sheet(inset) 契约测试
 *
 * 覆盖：
 * 1. ScrollArea / SegmentedControl / Tabs / Popover / PreviewCard / Tooltip / Menu /
 *    Dialog / AlertDialog / Sheet(inset) / Command(CommandPanel) / Toast / InputGroup / Switch SSR 与 data-slot 契约；
 * 2. 所有新增交互原语声明 motion-reduce:transition-none / motion-reduce:animate-none；
 * 3. ReadingIsland 彻底移除右缘 fixed 压盖（零 fixed right-0 top-1/2）、默认顶栏紧凑微胶囊 + Sheet(inset) 抽屉 + 中文三项总览。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AlertDialog,
  AlertDialogTrigger,
  AnchoredToastProvider,
  Button,
  CommandFooter,
  CommandInput,
  CommandPanel,
  CommandShortcut,
  Dialog,
  DialogTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuTrigger,
  Popover,
  PopoverTrigger,
  PreviewCard,
  PreviewCardTrigger,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Sheet,
  SheetTrigger,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  ToastProvider,
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from '../src/components/ui/index';
import ReadingIsland, { ReadingIslandPanel } from '../src/components/ReadingIsland';
import { computeReadingIslandStats } from '../src/utils/readingIslandStats';
import type { FileRecord, WorkspaceConfig } from '../src/types/guanlan';

function readSrc(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relPath}`, import.meta.url)), 'utf8');
}

test('V02 ScrollArea / SegmentedControl / Tabs / InputGroup / Switch 原语 SSR 契约', () => {
  const scrollHtml = renderToStaticMarkup(
    createElement(ScrollArea, { scrollFade: true }, createElement('div', null, '可滚内容')),
  );
  assert.ok(scrollHtml.includes('data-slot="scroll-area"'));
  assert.ok(scrollHtml.includes('data-slot="scroll-area-viewport"'));
  assert.ok(scrollHtml.includes('data-slot="scroll-area-content"'));
  assert.ok(scrollHtml.includes('mask-t-from-'));

  const segHtml = renderToStaticMarkup(
    createElement(
      SegmentedControl,
      { size: 'sm' },
      createElement(SegmentedControlItem, { 'aria-pressed': true }, '近7天'),
      createElement(SegmentedControlItem, { 'aria-pressed': false }, '近30天'),
    ),
  );
  assert.ok(segHtml.includes('data-slot="segmented-control"'));
  assert.ok(segHtml.includes('data-slot="segmented-control-indicator"'));
  assert.ok(segHtml.includes('motion-reduce:transition-none'));

  const tabsHtml = renderToStaticMarkup(
    createElement(
      Tabs,
      { defaultValue: 'star' },
      createElement(
        TabsList,
        null,
        createElement(TabsTab, { value: 'star' }, '星图'),
        createElement(TabsTab, { value: 'calendar' }, '日历'),
      ),
      createElement(TabsPanel, { value: 'star' }, '星图内容'),
    ),
  );
  assert.ok(tabsHtml.includes('data-slot="tabs"'));
  assert.ok(tabsHtml.includes('data-slot="tabs-list"'));
  assert.ok(tabsHtml.includes('data-slot="tab-indicator"'));
  assert.ok(tabsHtml.includes('data-slot="tabs-content"'));

  const inputGroupHtml = renderToStaticMarkup(
    createElement(
      InputGroup,
      null,
      createElement(InputGroupAddon, null, '筛'),
      createElement(InputGroupInput, { placeholder: '过滤目录…' }),
    ),
  );
  assert.ok(inputGroupHtml.includes('data-slot="input-group"'));
  assert.ok(inputGroupHtml.includes('data-slot="input-group-addon"'));
  assert.ok(inputGroupHtml.includes('data-slot="input"'));

  const soloInputHtml = renderToStaticMarkup(createElement(Input, { size: 'sm', placeholder: '名称' }));
  assert.ok(soloInputHtml.includes('data-slot="input-control"'));

  const switchHtml = renderToStaticMarkup(createElement(Switch, { defaultChecked: true }));
  assert.ok(switchHtml.includes('data-slot="switch"'));
  assert.ok(switchHtml.includes('data-slot="switch-thumb"'));
});

test('V02 Popover / PreviewCard / Tooltip / Menu / Dialog / AlertDialog / Sheet / Command / Toast 原语 SSR 契约', () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      { position: 'bottom-right' },
      createElement(
        AnchoredToastProvider,
        null,
        createElement(
          TooltipProvider,
          null,
          createElement(Popover, null, createElement(PopoverTrigger, null, '日历弹层')),
          createElement(PreviewCard, null, createElement(PreviewCardTrigger, null, '速览触发')),
          createElement(Tooltip, null, createElement(TooltipTrigger, null, '提示')),
          createElement(Menu, null, createElement(MenuTrigger, null, '菜单')),
          createElement(Dialog, null, createElement(DialogTrigger, null, '弹窗')),
          createElement(AlertDialog, null, createElement(AlertDialogTrigger, null, '二次确认')),
          createElement(Sheet, null, createElement(SheetTrigger, null, '抽屉')),
        ),
      ),
    ),
  );
  assert.ok(html.includes('data-slot="popover-trigger"'));
  assert.ok(html.includes('data-slot="preview-card-trigger"'));
  assert.ok(html.includes('data-slot="tooltip-trigger"'));
  assert.ok(html.includes('data-slot="menu-trigger"'));
  assert.ok(html.includes('data-slot="dialog-trigger"'));
  assert.ok(html.includes('data-slot="alert-dialog-trigger"'));
  assert.ok(html.includes('data-slot="sheet-trigger"'));

  const cmdHtml = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(CommandInput, { placeholder: '时空检索…' }),
      createElement(CommandPanel, null, createElement(Button, { size: 'xs' }, '结果')),
      createElement(CommandFooter, null, createElement(CommandShortcut, null, 'Enter')),
    ),
  );
  assert.ok(cmdHtml.includes('data-slot="command-input"'));
  assert.ok(cmdHtml.includes('data-slot="command-panel"'));
  assert.ok(cmdHtml.includes('data-slot="command-footer"'));
  assert.ok(cmdHtml.includes('data-slot="command-shortcut"'));
});

test('V02 全量交互原语遵循 prefers-reduced-motion 降级契约', () => {
  const files = [
    'components/ui/scroll-area.tsx',
    'components/ui/segmented-control.tsx',
    'components/ui/tabs.tsx',
    'components/ui/popover.tsx',
    'components/ui/preview-card.tsx',
    'components/ui/tooltip.tsx',
    'components/ui/dialog.tsx',
    'components/ui/alert-dialog.tsx',
    'components/ui/sheet.tsx',
    'components/ui/command.tsx',
    'components/ui/toast.tsx',
    'components/ui/menu.tsx',
    'components/ui/input.tsx',
    'components/ui/switch.tsx',
  ];
  for (const rel of files) {
    const src = readSrc(rel);
    assert.ok(
      src.includes('motion-reduce:transition-none') || src.includes('motion-reduce:animate-none'),
      `${rel} 必须显式声明 motion-reduce 降级`,
    );
  }
});

test('V02 ReadingIsland 根治右缘遮挡：零 fixed right-0 悬浮条 + Sheet inset + 中文三项总览', () => {
  const islandSrc = readSrc('components/ReadingIsland.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!islandSrc.includes('fixed right-0'), '代码体彻底移除压盖右侧栏的 fixed right-0 悬浮条');
  assert.ok(islandSrc.includes('variant="inset"'), '展开抽屉走 coss Sheet inset 悬浮圆角形态');

  const sampleFile = {
    file_id: 'f_v02_01',
    folder: '01-方案文档',
    title: '架构设计',
    relative_path: '01-方案文档/架构设计.md',
    format: 'md',
    current_revision_id: 'rev_1',
    coverage: 'full_text',
    role: '说明',
    revisions: [
      {
        revision_id: 'rev_1',
        versionNumber: 1,
        observed_at: '2026-11-23T10:00:00+08:00',
        snapshotAvailable: true,
        summaryNote: '',
      },
    ],
  } as unknown as FileRecord;

  const pillHtml = renderToStaticMarkup(
    createElement(ReadingIsland, {
      files: [sampleFile],
      readingStates: {},
      quota: { usedTotalMiB: 5, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
    }),
  );
  assert.ok(pillHtml.includes('data-island-placement="header"'), '默认顶栏横向微胶囊形态');
  assert.ok(!pillHtml.includes('fixed right-0'), '渲染树零 fixed right-0 叠加');

  const stats = computeReadingIslandStats([sampleFile], {});
  const panelHtml = renderToStaticMarkup(
    createElement(ReadingIslandPanel, {
      inSheet: true,
      stats,
      quota: { usedTotalMiB: 5, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
      onClose: () => {},
    }),
  );
  assert.ok(panelHtml.includes('data-slot="frame"'), '展开抽屉内置 coss Frame 三项中文总览');
  assert.ok(panelHtml.includes('data-slot="scroll-area"'), '清单区走 coss ScrollArea scrollFade');
  assert.ok(
    panelHtml.includes('>已读<') && panelHtml.includes('>未读<') && panelHtml.includes('>已落盘<'),
    '明确中文三项标签，消除纯图标盲猜',
  );
});
