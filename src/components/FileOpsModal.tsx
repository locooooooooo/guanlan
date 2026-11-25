import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FolderInput,
  FolderOpen,
  Link2,
  Loader2,
  Pencil,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Button, IconButton } from './ui/primitives';
import {
  fileNameOf,
  parentDirOf,
  validateMoveInput,
  validateRenameInput,
  type SupportedFileFormat,
} from '../utils/fileOps';
import { displayFolderLabel } from '../utils/workspacePaths';
import type { AffectedReferenceItem } from '../hooks/useReferencePathRepair';

export type FileOpModalKind = 'rename' | 'move' | 'trash';

export interface FileOpModalRequest {
  kind: FileOpModalKind;
  fileId: string;
  relativePath: string;
  title: string;
  format: SupportedFileFormat;
  revisionCount?: number;
  linkedDecisionCount?: number;
}

export type FileOpSubmitPayload =
  | { kind: 'rename'; fileId: string; newName: string; updateReferences?: boolean }
  | {
      kind: 'move';
      fileId: string;
      targetDir: string;
      newName?: string;
      /** 确认制引用修复：用户在弹窗显式勾选后才为 true（绝不静默改写原文档）。 */
      updateReferences?: boolean;
    }
  | { kind: 'trash'; fileId: string; confirm: true };

/** 受影响引用清单状态（宿主由 useReferencePathRepair 收集后传入；零 IO 同步）。 */
export interface ReferenceImpactState {
  loading: boolean;
  items: AffectedReferenceItem[];
  /** 桌面壳保存桥是否可用（false＝修复能力诚实禁用，只读预览清单）。 */
  saveAvailable: boolean;
}

export interface FileOpsModalProps {
  request: FileOpModalRequest | null;
  folderOptions: string[];
  submitting: boolean;
  serverError: string | null;
  onClose: () => void;
  onSubmit: (payload: FileOpSubmitPayload) => Promise<void> | void;
  /** 移动/改名涉及被 Markdown 决定证据引用的目标时的受影响引用清单。 */
  referenceImpact?: ReferenceImpactState | null;
}

/**
 * 独立文件操作弹窗（重命名 / 跨目录移动 / 移入系统回收站）。
 *
 * 设计约束：
 * - 严格保持独立组件，不向 App.tsx 堆叠表单状态；
 * - 颜色与动效全部取自 :root 设计令牌与 ui/primitives；
 * - 移入回收站强制勾选人工二次确认，绝不执行静默删除或永久物理删除；
 * - 移动弹窗采用可输入过滤的目标目录选择器（过滤输入常驻），自动隐藏被移动文件当前所在目录防成环；
 * - 移动/改名涉及被 Markdown 决定证据引用的目标（.pdf/.xlsx/.docx/.svg）时，
 *   预览受影响引用清单并由用户显式勾选是否同步更新相对路径——严格确认制，
 *   绝不静默改写原文档（取消＝零改写；保存桥不可用时禁用并诚实说明）。
 */
export const FileOpsModal: React.FC<FileOpsModalProps> = ({
  request,
  folderOptions,
  submitting,
  serverError,
  onClose,
  onSubmit,
  referenceImpact = null,
}) => {
  const [newName, setNewName] = useState('');
  const [targetDir, setTargetDir] = useState('');
  const [moveNewName, setMoveNewName] = useState('');
  const [folderFilter, setFolderFilter] = useState('');
  const [trashConfirmed, setTrashConfirmed] = useState(false);
  const [updateReferencesConfirmed, setUpdateReferencesConfirmed] = useState(false);

  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const moveDirInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!request) return;
    const base = fileNameOf(request.relativePath);
    const dir = parentDirOf(request.relativePath);
    setNewName(base);
    setTargetDir(dir);
    setMoveNewName('');
    setFolderFilter('');
    setTrashConfirmed(false);
    setUpdateReferencesConfirmed(false);

    if (request.kind === 'rename') {
      window.setTimeout(() => {
        const input = renameInputRef.current;
        if (!input) return;
        input.focus();
        const dotIdx = base.lastIndexOf('.');
        if (dotIdx > 0) {
          input.setSelectionRange(0, dotIdx);
        } else {
          input.select();
        }
      }, 0);
    } else if (request.kind === 'move') {
      window.setTimeout(() => {
        moveDirInputRef.current?.focus();
      }, 0);
    }
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [request, submitting, onClose]);

  const currentDir = request ? parentDirOf(request.relativePath) : '';
  const currentBase = request ? fileNameOf(request.relativePath) : '';

  const renameCheck = useMemo(() => {
    if (!request || request.kind !== 'rename') return null;
    return validateRenameInput(newName, request.relativePath, request.format);
  }, [newName, request]);

  const moveCheck = useMemo(() => {
    if (!request || request.kind !== 'move') return null;
    return validateMoveInput(
      targetDir,
      request.relativePath,
      request.format,
      moveNewName.trim() ? moveNewName : undefined
    );
  }, [moveNewName, request, targetDir]);

  const filteredFolders = useMemo(() => {
    // 防成环——目录列表自动隐藏被移动文件当前所在目录（同目录落点为无效目标，只保留合法目标）。
    const candidates = folderOptions.filter((dir) => dir !== currentDir);
    const q = folderFilter.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((dir) => {
      const label = displayFolderLabel(dir).toLowerCase();
      return label.includes(q) || dir.toLowerCase().includes(q);
    });
  }, [currentDir, folderFilter, folderOptions]);

  if (!request) return null;

  const referenceImpactVisible =
    referenceImpact !== null &&
    (request.kind === 'move' || request.kind === 'rename') &&
    referenceImpact.items.length > 0;
  const referenceRepairSelectable =
    referenceImpactVisible && referenceImpact.saveAvailable && !referenceImpact.loading;

  const canSubmit =
    !submitting &&
    (request.kind === 'rename'
      ? Boolean(renameCheck?.ok)
      : request.kind === 'move'
        ? Boolean(moveCheck?.ok)
        : trashConfirmed);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (request.kind === 'rename' && renameCheck?.ok) {
      void onSubmit({
        kind: 'rename',
        fileId: request.fileId,
        newName: renameCheck.normalizedName,
        // 确认制：仅用户显式勾选且保存桥可用时才同步更新引用路径
        updateReferences: referenceRepairSelectable ? updateReferencesConfirmed : undefined,
      });
    } else if (request.kind === 'move' && moveCheck?.ok) {
      void onSubmit({
        kind: 'move',
        fileId: request.fileId,
        targetDir: moveCheck.targetDir,
        newName: moveNewName.trim() ? moveCheck.fileName : undefined,
        updateReferences: referenceRepairSelectable ? updateReferencesConfirmed : undefined,
      });
    } else if (request.kind === 'trash' && trashConfirmed) {
      void onSubmit({
        kind: 'trash',
        fileId: request.fileId,
        confirm: true,
      });
    }
  };

  const headerMeta =
    request.kind === 'rename'
      ? {
          icon: <Pencil className="w-4 h-4 text-[color:var(--accent-iris-deep)] shrink-0" />,
          title: '安全重命名',
          subtitle: '同目录原子改名，file_id、版本链、关联决定与阅读进度 100% 连续',
        }
      : request.kind === 'move'
        ? {
            icon: <FolderInput className="w-4 h-4 text-[color:var(--accent-iris-deep)] shrink-0" />,
            title: '移动到工作区目录',
            subtitle: '工作区边界内跨目录移动并自动登记路径别名，绝不断链',
          }
        : {
            icon: <Trash2 className="w-4 h-4 text-[color:var(--btn-danger-ink)] shrink-0" />,
            title: '移入系统回收站',
            subtitle: '仅投递至操作系统回收站，不执行永久物理删除，可随时还原重连',
          };

  const showRenameError =
    request.kind === 'rename' &&
    renameCheck &&
    !renameCheck.ok &&
    newName.trim() !== currentBase;

  const showMoveError =
    request.kind === 'move' &&
    moveCheck &&
    !moveCheck.ok &&
    (targetDir.trim() !== currentDir || moveNewName.trim().length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={headerMeta.title}
      data-file-ops-modal={request.kind}
      data-esc-layer="open"
      className="glx-backdrop-in fixed inset-0 z-[95] flex items-center justify-center p-4 bg-[color:color-mix(in_srgb,var(--ink-strong)_38%,transparent)] dark:bg-black/62 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <form
        onSubmit={handleFormSubmit}
        className="glass-pop glx-modal-in w-full max-w-lg rounded-[var(--r-card)] overflow-hidden flex flex-col"
        style={{ border: 'none' }}
      >
        {/* 顶栏 */}
        <div className="px-6 py-4 border-b border-[color:var(--glass-hairline)] bg-card/85 backdrop-blur-md flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)] flex items-center gap-2">
              {headerMeta.icon}
              <span>{headerMeta.title}</span>
            </h2>
            <p className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] mt-0.5">
              {headerMeta.subtitle}
            </p>
          </div>
          <IconButton
            label="关闭文件操作窗口"
            disabled={submitting}
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* 主体 */}
        <div className="p-5 space-y-4">
          {/* 文件身份卡 */}
          <div className="px-3 py-2.5 rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-muted/45 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[length:var(--text-ui-body)] font-medium text-[color:var(--ink-strong)] truncate">
                {request.title}
              </span>
              <span className="font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)] shrink-0">
                {request.format.toUpperCase()} · {request.fileId}
              </span>
            </div>
            <div
              className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] break-all"
              title={request.relativePath}
            >
              当前路径：{request.relativePath}
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-0.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
              <span className="inline-flex items-center gap-1">
                <Link2 className="w-3 h-3 text-[color:var(--accent-iris-deep)]" />
                <span>
                  {typeof request.revisionCount === 'number'
                    ? `${request.revisionCount} 个历史版本保持连续`
                    : '历史版本链保持连续'}
                </span>
              </span>
              {typeof request.linkedDecisionCount === 'number' && request.linkedDecisionCount > 0 && (
                <span>· 关联 {request.linkedDecisionCount} 条决定依据</span>
              )}
            </div>
          </div>

          {/* 模式 1：重命名 */}
          {request.kind === 'rename' && (
            <div className="space-y-2.5">
              <label
                htmlFor="guanlan-file-rename-input"
                className="block text-[length:var(--text-ui)] font-medium text-[color:var(--ink-strong)]"
              >
                新文件名（须保留 {request.format.toUpperCase()} 扩展名）
              </label>
              <input
                id="guanlan-file-rename-input"
                ref={renameInputRef}
                type="text"
                value={newName}
                disabled={submitting}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={currentBase}
                className="glass-input w-full px-3 py-2 rounded-[var(--r-ctl)] font-mono text-[length:var(--text-ui-body)] text-[color:var(--ink-strong)] outline-none focus:border-[color:var(--accent-iris-deep)]"
              />
              {renameCheck?.ok && (
                <div className="text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)] break-all">
                  重命名后路径：
                  <span className="text-[color:var(--accent-iris-ink)]">
                    {renameCheck.targetRelativePath}
                  </span>
                </div>
              )}
              {showRenameError && renameCheck && !renameCheck.ok && (
                <div
                  role="alert"
                  className="text-[length:var(--text-micro)] text-[color:var(--btn-danger-ink)] flex items-start gap-1.5"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{renameCheck.error}</span>
                </div>
              )}
            </div>
          )}

          {/* 模式 2：跨目录移动 */}
          {request.kind === 'move' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="guanlan-file-move-dir-input"
                  className="block text-[length:var(--text-ui)] font-medium text-[color:var(--ink-strong)]"
                >
                  目标目录（留空表示工作区根目录，可输入新子目录自动创建）
                </label>
                <input
                  id="guanlan-file-move-dir-input"
                  ref={moveDirInputRef}
                  type="text"
                  value={targetDir}
                  disabled={submitting}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="例如：02-归档专项/定稿（留空 = 工作区根目录）"
                  className="glass-input w-full px-3 py-2 rounded-[var(--r-ctl)] font-mono text-[length:var(--text-ui-body)] text-[color:var(--ink-strong)] outline-none focus:border-[color:var(--accent-iris-deep)]"
                />
              </div>

              {/* 现有目录快选（可输入过滤的目标目录选择器——过滤输入常驻；
                  列表自动隐藏当前所在目录防成环，只呈现合法目标） */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                    快速选择工作区已有目录（{filteredFolders.length}
                    {currentDir ? '；已隐藏当前所在目录' : ''}）
                  </span>
                  <input
                    type="text"
                    value={folderFilter}
                    disabled={submitting}
                    onChange={(e) => setFolderFilter(e.target.value)}
                    placeholder="筛选目录…"
                    aria-label="筛选已有目录"
                    className="glass-input px-2 py-0.5 w-36 rounded-[var(--r-ctl)] text-[length:var(--text-micro)] text-[color:var(--ink-strong)] outline-none focus:border-[color:var(--accent-iris-deep)]"
                  />
                </div>
                <div className="max-h-36 overflow-y-auto rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-muted/40 p-1 space-y-0.5">
                  {filteredFolders.length === 0 ? (
                    <div className="px-2.5 py-2 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                      无匹配已有目录；可直接保留上方输入框路径以在工作区内自动创建该子目录。
                    </div>
                  ) : (
                    filteredFolders.map((dir) => {
                      const isSelected = targetDir.trim().replace(/\\/g, '/') === dir;
                      return (
                        <button
                          key={dir || '__root__'}
                          type="button"
                          disabled={submitting}
                          onClick={() => setTargetDir(dir)}
                          className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[var(--r-ctl)] text-left font-mono text-[length:var(--text-micro)] cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] font-medium'
                              : 'text-[color:var(--ink-strong)] hover:bg-[color:var(--btn-ghost-bg-hover)]'
                          }`}
                        >
                          <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                            <FolderOpen className="w-3.5 h-3.5 shrink-0 opacity-75" />
                            <span className="truncate">{displayFolderLabel(dir)}</span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 可选同步改名 */}
              <div className="space-y-1">
                <label
                  htmlFor="guanlan-file-move-rename-input"
                  className="block text-[length:var(--text-micro)] text-[color:var(--ink-soft)]"
                >
                  可选：移动时同步修改文件名（留空保持 {currentBase}）
                </label>
                <input
                  id="guanlan-file-move-rename-input"
                  type="text"
                  value={moveNewName}
                  disabled={submitting}
                  onChange={(e) => setMoveNewName(e.target.value)}
                  placeholder={currentBase}
                  className="glass-input w-full px-3 py-1.5 rounded-[var(--r-ctl)] font-mono text-[length:var(--text-micro)] text-[color:var(--ink-strong)] outline-none focus:border-[color:var(--accent-iris-deep)]"
                />
              </div>

              {moveCheck?.ok && (
                <div className="text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)] break-all">
                  移动后路径：
                  <span className="text-[color:var(--accent-iris-ink)]">
                    {moveCheck.targetRelativePath}
                  </span>
                </div>
              )}
              {showMoveError && moveCheck && !moveCheck.ok && (
                <div
                  role="alert"
                  className="text-[length:var(--text-micro)] text-[color:var(--btn-danger-ink)] flex items-start gap-1.5"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{moveCheck.error}</span>
                </div>
              )}
            </div>
          )}

          {/* 模式 3：移入系统回收站（强制二次确认） */}
          {request.kind === 'trash' && (
            <div className="space-y-3">
              <div className="p-3 rounded-[var(--r-block)] border border-[color:var(--btn-danger-border)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_6%,transparent)] space-y-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)]">
                <div className="flex items-center gap-1.5 font-semibold text-[color:var(--btn-danger-ink)]">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>安全保障：仅移入操作系统回收站，绝不永久物理删除</span>
                </div>
                <p className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                  文件移入回收站后将从当前活动清单隐藏，但其历史版本快照、事件账本与阅读进度均完整保留。
                  随时可在系统回收站执行「还原」，观澜刷新后将自动重连原 <code className="font-mono">{request.fileId}</code>。
                </p>
              </div>

              <label className="flex items-start gap-2.5 p-2.5 rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-muted/45 cursor-pointer select-none">
                <input
                  type="checkbox"
                  data-trash-confirm-checkbox=""
                  checked={trashConfirmed}
                  disabled={submitting}
                  onChange={(e) => setTrashConfirmed(e.target.checked)}
                  className="mt-0.5 accent-[color:var(--btn-danger-ink)] cursor-pointer"
                />
                <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)]">
                  我确认将 <span className="font-mono font-semibold">{currentBase}</span> 移入操作系统回收站
                </span>
              </label>
            </div>
          )}

          {/* 确认制引用路径修复（移动/改名涉及被 Markdown 决定证据引用的目标）：
              弹窗预览受影响引用清单，用户显式勾选后才同步更新相对路径——
              严格确认制，绝不静默改写原文档；取消＝零改写；
              保存桥不可用（浏览器/CLI 只读环境）＝修复能力诚实禁用 */}
          {referenceImpactVisible && (
            <div
              className="space-y-2"
              data-reference-impact=""
              aria-label="受影响引用清单"
            >
              <div className="p-3 rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-muted/40 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[length:var(--text-ui)] font-medium text-[color:var(--ink-strong)]">
                  <Link2 className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
                  <span>
                    受影响引用清单（{referenceImpact.items.length} 处）
                  </span>
                </div>
                <p className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                  {request.kind === 'move' ? '移动' : '重命名'}后，下列 Markdown 决定文档中的
                  相对路径引用将指向旧路径。勾选下方确认后才会同步更新（严格确认制，默认零改写）：
                </p>
                <div
                  className="max-h-32 overflow-y-auto rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/75 divide-y divide-[color:var(--glass-hairline)]"
                  data-reference-impact-list=""
                >
                  {referenceImpact.items.map((item, index) => (
                    <div
                      key={`${item.kind}:${item.sourceFileId}:${item.line ?? 'na'}:${index}`}
                      className="px-2.5 py-1.5 flex items-start justify-between gap-2"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-strong)] truncate">
                          {item.sourcePath}
                          {item.line !== null && (
                            <span className="text-[color:var(--ink-soft)]"> L{item.line}</span>
                          )}
                        </div>
                        <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] truncate">
                          {item.kind === 'decision_evidence'
                            ? `决定 ${item.decisionCode ?? ''}：${item.decisionQuestion ?? item.sourceTitle}`
                            : item.sourceTitle}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 text-[10px] font-mono ${
                          item.kind === 'decision_evidence'
                            ? 'text-[color:var(--accent-iris-deep)]'
                            : 'text-[color:var(--ink-soft)]'
                        }`}
                      >
                        {item.kind === 'decision_evidence' ? '决定证据' : '正文链接'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <label
                className={`flex items-start gap-2.5 p-2.5 rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-muted/45 select-none ${
                  referenceRepairSelectable ? 'cursor-pointer' : 'opacity-60'
                }`}
                data-reference-confirm-row=""
              >
                <input
                  type="checkbox"
                  data-reference-confirm-checkbox=""
                  checked={referenceRepairSelectable ? updateReferencesConfirmed : false}
                  disabled={!referenceRepairSelectable || submitting}
                  onChange={(e) => setUpdateReferencesConfirmed(e.target.checked)}
                  className="mt-0.5 accent-[color:var(--accent-iris-deep)] cursor-pointer"
                />
                <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)]">
                  确认同步更新上述引用的相对路径（CAS 乐观锁写回，冲突时绝不覆盖原文件）
                </span>
              </label>
              {!referenceImpact.saveAvailable && (
                <p className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)] flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    桌面壳保存桥不可用（浏览器/CLI 只读环境）：仅预览清单，引用修复不可用——
                    取消或继续操作都不会改写任何原文档。
                  </span>
                </p>
              )}
            </div>
          )}

          {/* 服务端返回错误 */}
          {serverError && (
            <div
              role="alert"
              data-file-ops-error=""
              className="p-2.5 rounded-[var(--r-block)] border border-[color:var(--btn-danger-border)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_8%,transparent)] text-[length:var(--text-micro)] text-[color:var(--btn-danger-ink)] flex items-start gap-2"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="break-all">{serverError}</span>
            </div>
          )}
        </div>

        {/* 底部动作栏 */}
        <div className="px-5 py-3 border-t border-[color:var(--glass-hairline)] bg-muted/45 flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="md"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </Button>
          {request.kind === 'trash' ? (
            <Button
              type="submit"
              variant="danger"
              size="md"
              data-file-ops-submit="trash"
              disabled={!canSubmit}
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              <span>{submitting ? '正在移入回收站…' : '确认移入回收站'}</span>
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="md"
              data-file-ops-submit={request.kind}
              disabled={!canSubmit}
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : request.kind === 'rename' ? (
                <Pencil className="w-3.5 h-3.5" />
              ) : (
                <FolderInput className="w-3.5 h-3.5" />
              )}
              <span>
                {submitting
                  ? '正在执行…'
                  : request.kind === 'rename'
                    ? '确认重命名'
                    : '确认移动'}
              </span>
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};
