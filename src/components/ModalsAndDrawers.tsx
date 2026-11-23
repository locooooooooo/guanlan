/**
 * V08 · 弹层与抽屉统一出口（原 1,510 行巨石已拆解至 components/modals/* 独立模块）。
 *
 * 保持既有导出名与类型签名 100% 向后兼容：
 * - WorkspaceSettingsModal → ./modals/WorkspaceSettingsModal（垂直 Tabs + Frame 分栏表单）
 * - McpConsoleModal        → ./modals/McpConsoleModal（8 项 MCP 工具契约调试台）
 * - AgentContextDrawer     → ./modals/AgentContextDrawer（证道阁悬浮 Sheet inset 证据篮）
 */

export {
  WorkspaceSettingsModal,
  SETTINGS_TABS,
  type SettingsTabId,
  type WorkspaceSettingsModalProps,
} from './modals/WorkspaceSettingsModal';

export {
  McpConsoleModal,
  type McpConsoleModalProps,
} from './modals/McpConsoleModal';

export {
  AgentContextDrawer,
  type AgentContextDrawerProps,
} from './modals/AgentContextDrawer';
