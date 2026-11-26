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
  enabled?: boolean;
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
