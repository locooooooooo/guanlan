/**
 * 弹层与抽屉统一出口（各模块实现位于 components/modals/*）。
 *
 * 保持既有导出名与类型签名向后兼容：
 * - WorkspaceSettingsModal → ./modals/WorkspaceSettingsModal（垂直 Tabs + Frame 分栏表单）
 * - McpConsoleModal        → ./modals/McpConsoleModal（8 项 MCP 工具契约调试台）
 * - AgentContextDrawer     → ./modals/AgentContextDrawer（悬浮 Sheet inset 上下文清单抽屉）
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
