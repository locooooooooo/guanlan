# 前端应用

前端是一个 React 19 单页应用，由 Vite 构建，Tailwind 4 负责样式。它的全部数据都来自本地 `guanlan serve` 的 `/api/v1`，自己不持久化任何业务事实；能在浏览器之外做的事（选文件夹、定位文件、保存回写）都经桌面壳注入的桥。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 入口 | 导入全局样式，首帧之前同步水合明暗主题，挂载 `App`。 | [`src/main.tsx`](../../src/main.tsx) |
| 装配层 | `App` 是**唯一**调用 `useWorkspaceStore()` 的地方。它只做装配：顶栏、工作区门禁、五个分节、弹窗栈。 | [`src/App.tsx`](../../src/App.tsx) |
| 状态 | `useWorkspaceStore` 是一个自定义 Hook，不是状态库。全部状态、副作用与处理器都在里面，返回一个 `ctx` 对象。 | [`src/stores/useWorkspaceStore.tsx`](../../src/stores/useWorkspaceStore.tsx) |
| 分节渲染 | `AppBanners`、`AppMainViews`、`AppLibraryStage`、`AppModalsStack`、`GlobalDirectorySidebar`（左侧目录栏仅展示当前聚焦的单个项目目录树，多项目切换与增删统一由顶栏 `TopHeader` 下拉触发）、`ProjectSwitchTransition`（切换聚焦项目期间的过渡条与整层遮罩），都接收 `{ ctx }`。 | [`src/components/app/`](../../src/components/app) |
| 取数客户端 | `workspaceClient.ts` 是 `src/` 里**唯一**调用 `fetch` 与 `EventSource` 的模块。 | [`src/services/workspaceClient.ts`](../../src/services/workspaceClient.ts) |
| 契约类型 | `apiTypes.ts` 手工镜像 Rust DTO；`types/guanlan.ts` 是视图模型与既有的 wire 字段名。 | [`src/services/apiTypes.ts`](../../src/services/apiTypes.ts)、[`src/types/guanlan.ts`](../../src/types/guanlan.ts) |
| 桌面桥 | `desktopBridge.ts` 包装壳注入的全局对象，在浏览器里全部优雅降级。 | [`src/services/desktopBridge.ts`](../../src/services/desktopBridge.ts) |
| 构建身份 | `appBuildInfo.ts` 读 Vite 编译期注入的版本、git 短哈希与构建时间。 | [`src/utils/appBuildInfo.ts`](../../src/utils/appBuildInfo.ts) |
| 构建配置 | `vite.config.ts` 注入 `define` 常量并把 `/api` 代理到本地服务。 | [`vite.config.ts`](../../vite.config.ts) |
| 基础组件 | `src/components/ui/` 基于 `@base-ui/react` 与 `class-variance-authority`；`cn()` 合并 Tailwind 类。 | [`src/components/ui/`](../../src/components/ui)、[`src/lib/cn.ts`](../../src/lib/cn.ts) |

`src/utils/guanlanEngine.ts` 名字带「engine」，但它是**在线的界面代码**：二十多个组件文件、六个工具模块和 store 直接导入它。里面是中文二元分词检索、Markdown 大纲、预算内的 diff、本地关系图、SVG 净化、未读判定，以及一个调试用的 MCP 契约控制台的客户端模拟（`executeMcpTool`，界面入口藏在 `localStorage` 的 `guanlan.debug.mcp` 开关后面，和真正的 `guanlan mcp` 代理不是一回事）。不要把它当成遗留代码清理。

真正只服务于旧 Node 管线的是 `src/services/FileScanner.ts` 与 `src/services/WorkspaceTransformer.ts`，见[旧 Node 管线与对拍](legacy-node-pipeline.md)。

## 运行路径

### 启动

`main.tsx` 先 `initAppThemeSync()` 再渲染，避免首帧闪烁。`App` 调用一次 store，拿到 `ctx` 后：

1. 顶栏 `TopHeader`。
2. 没有可用后端且处于桌面会话时，渲染 `WorkspaceGateModal`（首启引导、切换工作区、`ROOT_IN_USE` 恢复）。
3. 否则渲染常驻目录侧栏、横幅栈与主视图；资产库页签下再渲染 `AppLibraryStage`。
4. 最后是抽屉与弹窗栈 `AppModalsStack`。
5. 切换聚焦项目期间，额外渲染 `ProjectSwitchTransition`（见下）。

### 取数

所有请求经 `workspaceClient.ts` 的 `requestJson` 与 `requestJsonPost`。两者**不抛异常**：`toResult` 只在状态码 2xx 且包络 `ok === true` 时算成功，网络层失败映射为 `code: 'ABORTED'` 或一句连接提示。基址默认同源；桌面壳通过 `window.__GUANLAN_API__` 注入内嵌服务的随机端口。

首屏流程在 store 的 bootstrap 效应里：`fetchBootstrap` → `fetchAllFileSummaries` 逐页续拉并 `applyFileSummaries` 合并进缓存 → `fetchRelations` → `fetchWorkspaceStatus`。续拉过程中若后台对账恰好完成（`status` 报的代际比首屏新），把 `bootstrapNonce` 加一，重新取一遍。

实时更新靠 `subscribeWorkspaceStream` 订阅 `GET /api/v1/stream`。它为 `hello` 与 `workspace-change` **显式注册命名事件监听器**，因为 `EventSource.onmessage` 只收未命名事件。

### 状态如何流动

- **事实放在 ref 里，React 状态是它的投影。** `fileCacheRef` 是文件清单的事实源；`files` 是它排序后的投影，由 `publishFiles` 以 150 毫秒尾沿防抖合批发布。单篇详情水合（`ensureFileDetail`）与 Markdown 正文补齐在目录元数据未变时仅写入局部 `hydratedFilesById`（`activeFile` 经 `fileById` + `hydratedFilesById` 以 O(1) 读取），避免选中文件触发整表重排与全站 `useMemo` 级联失效；`applyFileSummaries` 发现新版本或删除时同步失效 `hydratedFilesById`。
- **SVG 封面正文补齐走目标化行替换。** `publishContentFor` 只替换一行，其余行保持引用身份，让首页/画廊卡片上的 memo 不失效。
- **关闭态浮层与非 Markdown 链接索引按需惰性计算。** 命令面板（`useCommandPalette`）、轻预览队列（`useQuickPreview`）、文件/目录移动选项（`useFileOps` / `fileOpFolderOptions`）、筛选下拉（`FilterDropdown`）、增量聚光灯（`spotlightItems`）、阅读岛明细表（`ReadingIsland`）及阅读器 Markdown 路径索引（`useReaderController`）在未开启或非 Markdown 文件时跳过全量扫描。
- **代际计数当竞态守卫。** `eventFetchGenRef` 让旧窗口的在途请求作废；`dayQueryRef` 配合 `sameDayQuery` 防止日期窗口串页。
- **按工作区分桶的持久化。** 阅读状态与静音文件夹按 `workspace_id` 分桶存在本机存储；阅读状态经 `coalescedPersist` 做 800 毫秒尾沿合批写入（页面隐藏、切换工作区或项目前立刻补写）。
- **切换工作区或项目时整体复位。** `resetWorkspaceScopedState` 重置全部工作区范围内的状态（含 SSE 断连状态与重扫/重试防重锁）。桌面端切换工作区期间，由 `switchingWorkspace` 与同步镜像 `switchingWorkspaceRef` 暂停旧后端的 SSE 订阅、任务与状态轮询以及断连/扫描失败红条，改为在 `AppBanners` 展示中性「正在切换工作区」状态条。
- **切换聚焦项目有过渡条。** `useMultiProjects` 的 `activatingProjectId` 是「正在激活的项目」的事实源：它在发起激活请求**之前**置上、在请求返回**之后**才清，中间至少维持 `PROJECT_SWITCH_FEEDBACK_MIN_MS`（400 毫秒），请求再快也不会只闪一帧。期间 `App` 渲染 `ProjectSwitchTransition`：窗口顶部一条不确定态进度条（`.glx-switch-progress`，只动 `transform`，`prefers-reduced-motion` 下停帧成整条实心亮线）加一层整窗遮罩，吞掉这期间的点击，避免切到一半误触。遮罩的 `z-index` 高于弹层（z-50）、低于 toast（z-60），切换失败的提示仍能看见。切换期间顶栏的项目下拉按钮禁用并转圈；`handleActivateProject` 用 `activatingRef` 拒绝并发的第二次切换。

### 订阅方式

视图不做选择器订阅。`App` 调用一次 Hook，把整个 `ctx` 传给五个分节，分节再按需解构 20 到 70 个字段。任何状态变化都会让 `App` 与五个分节重新渲染，下层视图通过逐个传 props 隔离。高频或局部的纯展示状态（画布主题 `canvasThemeStore`、后台语义整理进度 `l4aProgressStore`）不进 store 状态，由对应叶子组件经 `useSyncExternalStore` 订阅，避免更新拖动整棵 `App` 树重渲。

store 反过来从组件导入值（`pageItemToEvent`、`enterEventFrame`、`Tabs`、`toastManager`），组件又从 store 导入类型与常量。这是导入 store 的测试会把整棵组件树拉进来的原因。

## 约束与失败行为

- **数据没接通时不拿演示样本兜底。** 未接通时是中性的空配置（`EMPTY_WORKSPACE_CONFIG`）；测试不得导入生产演示数据。
- **清单不完整时不剪枝。** 后台续拉失败时缓存只是部分清单，直接按它剪枝会把未拉到页文件的阅读进度、收藏与本地批注永久删除，且阅读状态会在合批窗口后写回本机，没有补救机会。只有续拉成功且清单完整（条数与服务端计数对得上）才剪枝。
- **磁盘改动带来新版本时必须让旧的详情缓存失效**，否则阅读器停在旧版本，「标为已读」会标错版本，未读永远清不掉。
- **失败或取消的内容请求不缓存成空对象**，否则同版本正文补齐后仍命中旧的空对象，预览永远缺失。
- **`.css` 只能在 `App.tsx` 里导入。** `node --test` 经 tsx 加载不了 `.css` 扩展名，组件内导入会让测试文件整个失败。
- **纯函数模块不得导入 `.css` 或 React。** `src/utils` 下的规则模块要在 node 测试里直接可导入。
- **存储访问必须对 `window` 不存在和抛异常都安全**（`safeStorage.ts`）。隐私收紧的浏览器里首次访问 `localStorage` 就会抛 `SecurityError`，在渲染路径里裸读会让整棵树白屏。
- **桌面壳 absent 时一切降级。** `desktopBridge.ts` 的每个函数都先判断桥是否存在。
- **构建身份在编译期注入**（`__GUANLAN_APP_VERSION__`、`__GUANLAN_GIT_SHA__`、`__GUANLAN_BUILD_TIME__`）。`appBuildInfo.ts` 在这些常量不存在时（node 测试）回退到兜底字面量。
- **没有国际化层。** 界面文案是中文字面量，`<html lang="zh-CN">`。
- **没有 ESLint、Prettier 或任何格式化工具。** `npm run lint` 是 `tsc --noEmit` 加注释门禁（`scripts/lint-comments.mjs`）。

## 样式约定

- Tailwind 4 工具类为主，语义色经 `index.css` 的 `@theme inline` 映射成 CSS 变量。
- 四个独立 CSS 文件：`index.css`（令牌与全局）、`styles/motion.css`（动效层）、`components/canvas/canvasWidgets.css`（舷窗内的 `.cvw-*`）、`components/eventGraph.css`（下钻层）。后两个只使用 `--cv-*` 令牌，`canvas-theme.test.ts` 守着画布文件里不出现裸十六进制色值。
- `data-*` 属性是测试钩子，例如 `data-cal-row`、`data-reader-shell`。

## 验证

```sh
npm run lint
npm test
npm run build
```

`npm test` 用 node:test 经 tsx 直接跑 TypeScript，共 119 个测试文件。断言有三种风格并存：调用真实函数或用 `react-dom/server` 渲染真实组件；把源码文件当字符串读出来做子串或正则匹配；个别用例起真实的本地 HTTP 桩服务或子进程。没有 DOM、没有事件模拟，点击与滚动的接线靠代码评审保证。

单独跑一个文件：

```sh
node node_modules/tsx/dist/cli.mjs --test test/a03-watcher-sse.test.ts
```
