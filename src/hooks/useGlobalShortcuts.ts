/**
 * D05 + V11 · 全局键盘分发层——window keydown 监听（挂载一次）+ 单键/两键和弦解析
 * （keyboardShortcuts 单一语义源）。
 *
 * 消费 STORE_SHORTCUT_ACTIONS（store 级动作）：
 *  - 1 / 2 / 3：切换「今日观澜 / 全景溯源 / 知识资产库」
 *  - G S / G C / G L：直达全景「司辰星图 / 日历看板 / 时光列表」（900ms 和弦窗口）
 *  - [ / ]：折展左侧目录栏 / 右侧检查器
 *  - undo-op / redo-op：文件操作专属 Undo/Redo 账本（Ctrl+Z / Ctrl+Shift+Z）
 *  - deep-read-focus：Enter 深度阅读当前焦点文件
 *  - open-version-diff：D 打开版本对比 / 时光机 / 版本链
 *  - add-focus-to-basket：C 加入证道阁上下文篮
 *
 * Z 归阅读器专注纸面（useReaderController，与全局键正交）；
 * J/K/H/L 归时间轴视图监听（useTimelineKeyboardNav）或星图聚光灯（GraphSpotlightBar）；
 * Alt+方向键归画布空间漫游（useCanvasSpatialNav）；Space 归 useQuickPreview；
 * Esc 与 '?' 归 useWorkspaceStore Esc 阶梯。各监听键位正交，绝不双解析。
 *
 * 仅在 onAction 返回 true（确实消费）时 preventDefault；两键和弦命中时同步
 * stopImmediatePropagation，防止 `G C` / `G L` 误触单键 `C` / `L`。
 */
import { useEffect, useRef } from 'react';
import {
  hasBlockingDomOverlay,
  isEditableLikeTarget,
  isShortcutChordPrefix,
  resolveShortcutActionFromEvent,
  resolveShortcutChord,
  SHORTCUT_CHORD_WINDOW_MS,
  STORE_SHORTCUT_ACTIONS,
  type ShortcutAction,
} from '../utils/keyboardShortcuts';

export interface UseGlobalShortcutsOptions {
  /** false = 整层停用（未接入后端的门禁态等；监听器内首行短路）。 */
  enabled?: boolean;
  /** 解析到 store 级动作后的执行入口；返回 true 表示已消费（触发 preventDefault）。 */
  onAction: (action: ShortcutAction) => boolean;
}

export function useGlobalShortcuts({
  enabled = true,
  onAction,
}: UseGlobalShortcutsOptions): void {
  const actionRef = useRef(onAction);
  useEffect(() => {
    actionRef.current = onAction;
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const chordRef = useRef<{ prefix: 'g'; expiresAt: number } | null>(null);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // 停机线①：编辑面（input/textarea/select/contenteditable）里一切键让路——
      // Ctrl+Z 恒留给原生文本撤销，绝不抢占（keyboardShortcuts.isEditableLikeTarget 同源）
      const editableTarget = isEditableLikeTarget(event.target);
      const overlayOpen = hasBlockingDomOverlay();
      const guard = { editableTarget, overlayOpen };

      if (editableTarget || overlayOpen || event.isComposing) {
        chordRef.current = null;
        return;
      }

      const now = Date.now();
      const activeChord =
        chordRef.current && chordRef.current.expiresAt >= now ? chordRef.current : null;

      // 优先检查两键和弦第二键（G S / G C / G L）
      if (activeChord) {
        chordRef.current = null;
        const chordAction = resolveShortcutChord(activeChord.prefix, event, guard);
        if (chordAction && STORE_SHORTCUT_ACTIONS.has(chordAction)) {
          const consumed = actionRef.current(chordAction);
          if (consumed) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          return;
        }
      }

      // 捕获两键和弦前缀键（G）
      const prefix = isShortcutChordPrefix(event, guard);
      if (prefix) {
        chordRef.current = { prefix, expiresAt: now + SHORTCUT_CHORD_WINDOW_MS };
        return;
      }

      const action = resolveShortcutActionFromEvent(event, guard);
      if (!action || !STORE_SHORTCUT_ACTIONS.has(action)) return;
      const consumed = actionRef.current(action);
      if (consumed) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);
}
