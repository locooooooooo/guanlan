
import React from 'react';
import { AlertTriangle, Columns, Code } from 'lucide-react';
import { Button } from '../ui/primitives';
import DiffSummaryCard from '../DiffSummaryCard';
import { revisionVersionLabel } from '../../utils/stateProjection';
import { formatRelativeObservedAt } from '../../utils/timeFormat';
import type { ReaderCtx } from './useReaderController';


/** === SUBMODE A: DIFF VIEW (对比上次阅读版本 / 历史快照对比) === */
export function ReaderDiffSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    subMode,
    paperLightMode,
    semanticDiff,
    effectiveFromRevId,
    effectiveToRevId,
    setCustomFromRevId,
    setCustomToRevId,
    onChangeSubMode,
    activeFile,
    readingState,
    diffLayout,
    setDiffLayout,
    diffResult,
    onChangeRevision,
    canCompareSinceRead,
    hasReadBaseline,
  } = ctx;
  return (
    <div
      className={`flex-1 overflow-y-auto p-6 space-y-4 ${
        paperLightMode
          ? 'bg-[#FAF9F5] text-[#1F1E1D]'
          : 'bg-[#101218] text-[#F4F3EE]'
      }`}
    >
      <div className="max-w-5xl mx-auto space-y-4">
        {subMode === 'diff_versions' && (
          <DiffSummaryCard
            result={semanticDiff.result}
            loading={semanticDiff.loading}
            error={semanticDiff.error}
            paperLightMode={paperLightMode}
            title="变更摘要"
          />
        )}
        <div
          className={`p-4 rounded-[14px] border flex flex-wrap items-center justify-between gap-4 ${
            paperLightMode
              ? 'bg-white/85 border-[color:var(--glass-hairline)] shadow-[0_2px_10px_-4px_rgba(38,36,61,0.06)]'
              : 'bg-[#171A24] border-white/[0.08] shadow-[0_8px_24px_-10px_rgba(0,0,0,0.45)]'
          }`}
        >
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span
              className={`font-semibold ${
                paperLightMode
                  ? 'text-[color:var(--ink-strong)]'
                  : 'text-[#F3F4F8]'
              }`}
            >
              {subMode === 'diff_since_read'
                ? !canCompareSinceRead
                  ? '无可比较的版本：'
                  : hasReadBaseline
                    ? '自上次阅读以来的变化对比：'
                    : '自最早收录版本以来的变化对比：'
                : '指定历史版本对比：'}
            </span>

            <label
              className={`flex items-center gap-1.5 ${
                paperLightMode ? 'text-[#6E6A61]' : 'text-[#A5A9BC]'
              }`}
            >
              <span>基线版本 (From)</span>
              <select
                aria-label="选择基线版本"
                value={effectiveFromRevId}
                onChange={(e) => {
                  setCustomFromRevId(e.target.value);
                  onChangeSubMode('diff_versions');
                }}
                className={`border rounded px-2 py-1 font-mono text-xs ${
                  paperLightMode
                    ? 'bg-white border-[#DDD9CF] text-[#1F1E1D]'
                    : 'bg-[#1F2230] border-white/[0.12] text-[#F3F4F8] [color-scheme:dark]'
                }`}
              >
                {activeFile.revisions.map((r) => (
                  <option key={r.revision_id} value={r.revision_id}>
                    {revisionVersionLabel(
                      r.versionNumber,
                      r.revision_id === activeFile.current_revision_id
                    )}
                    {!r.snapshotAvailable ? ' [快照已清理]' : ''}
                    {readingState?.last_read_revision_id === r.revision_id
                      ? ' [上次已读]'
                      : ''}
                  </option>
                ))}
              </select>
            </label>

            <span
              className={
                paperLightMode
                  ? 'text-[#6E6A61]'
                  : 'text-[#A5A9BC]'
              }
            >
              →
            </span>

            <label
              className={`flex items-center gap-1.5 ${
                paperLightMode ? 'text-[#6E6A61]' : 'text-[#A5A9BC]'
              }`}
            >
              <span>目标版本 (To)</span>
              <select
                aria-label="选择目标版本"
                value={effectiveToRevId}
                onChange={(e) => {
                  setCustomToRevId(e.target.value);
                  onChangeSubMode('diff_versions');
                }}
                className={`border rounded px-2 py-1 font-mono text-xs ${
                  paperLightMode
                    ? 'bg-white border-[#DDD9CF] text-[#1F1E1D]'
                    : 'bg-[#1F2230] border-white/[0.12] text-[#F3F4F8] [color-scheme:dark]'
                }`}
              >
                {activeFile.revisions.map((r) => (
                  <option key={r.revision_id} value={r.revision_id}>
                    {revisionVersionLabel(
                      r.versionNumber,
                      r.revision_id === activeFile.current_revision_id
                    )}
                    {r.revision_id === activeFile.current_revision_id ? ' [当前最新]' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <Button
              variant={diffLayout === 'split' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setDiffLayout('split')}
            >
              <Columns className="w-3.5 h-3.5" />
              <span>并排视图</span>
            </Button>
            <Button
              variant={diffLayout === 'unified' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setDiffLayout('unified')}
            >
              <Code className="w-3.5 h-3.5" />
              <span>合并视图</span>
            </Button>
          </div>
        </div>

        {subMode === 'diff_since_read' && !canCompareSinceRead ? (
          <div
            role="status"
            className={`p-5 rounded-lg border space-y-2 ${
              paperLightMode
                ? 'bg-white/85 border-[#E3E0D8] text-[#6E6A61]'
                : 'bg-[#171A24] border-white/[0.08] text-[#A5A9BC]'
            }`}
          >
            <div
              className={`text-sm font-semibold ${
                paperLightMode
                  ? 'text-[#1F1E1D]'
                  : 'text-[#F3F4F8]'
              }`}
            >
              无可比较的版本
            </div>
            <p className="text-xs leading-relaxed">
              该文档当前只收录了一个版本，没有可对照的历史基线；
              因此不展示空 diff 冒充「没有变化」。
            </p>
            <Button variant="secondary" size="sm" className="mt-1" onClick={() => onChangeSubMode('read')}>
              返回当前版本阅读
            </Button>
          </div>
        ) : activeFile.format === 'pdf' ? (
          <div
            className={`p-5 rounded-lg border space-y-4 ${
              paperLightMode
                ? 'bg-white/85 border-[#E3E0D8]'
                : 'bg-[#171A24] border-white/[0.08]'
            }`}
          >
            <div className="text-sm font-semibold text-[color:var(--stage-ink-decision-text)]">
              PDF 二进制版本元数据对照（首版不将二进制变化伪装成语义 diff）
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs tabular-nums">
              {[
                activeFile.revisions.find((r) => r.revision_id === effectiveFromRevId),
                activeFile.revisions.find((r) => r.revision_id === effectiveToRevId),
              ].map((rev, idx) =>
                rev ? (
                  <div
                    key={`${rev.revision_id}-${idx}`}
                    className={`p-4 rounded border space-y-2 ${
                      paperLightMode
                        ? 'bg-white border-[#DDD9CF]'
                        : 'bg-[#1D202C] border-white/[0.08]'
                    }`}
                  >
                    <div
                      className={`font-semibold ${
                        paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
                      }`}
                    >
                      {idx === 0 ? '旧版本快照' : '目标版本快照'} · {rev.revision_id}
                    </div>
                    <div>文件大小：{(rev.sizeBytes / (1024 * 1024)).toFixed(2)} MiB</div>
                    <div className="truncate">SHA-256：{rev.content_sha256}</div>
                    <div>观察时间：{formatRelativeObservedAt(rev.observed_at)}</div>
                    <div
                      className={`font-sans ${paperLightMode ? 'text-[#6E6A61]' : 'text-[#A5A9BC]'}`}
                    >
                      {rev.summaryNote}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        onChangeRevision(rev.revision_id);
                        onChangeSubMode('read');
                      }}
                    >
                      打开此版本阅读入口
                    </Button>
                  </div>
                ) : null
              )}
            </div>
          </div>
        ) : !diffResult ? (
          <div
            role="status"
            className={`p-5 rounded-lg border space-y-2 ${
              paperLightMode
                ? 'bg-white/85 border-[#E3E0D8] text-[#6E6A61]'
                : 'bg-[#171A24] border-white/[0.08] text-[#A5A9BC]'
            }`}
          >
            <p className="text-xs leading-relaxed">正在准备对比……</p>
          </div>
        ) : !diffResult.ok ? (
          diffResult.errorCode === 'CONTENT_NOT_LOADED' ? (
            <div
              role="status"
              className={`p-5 rounded-lg border space-y-2 ${
                paperLightMode
                  ? 'bg-white/85 border-[#E3E0D8] text-[#6E6A61]'
                  : 'bg-[#171A24] border-white/[0.08] text-[#A5A9BC]'
              }`}
            >
              <div className="text-sm font-semibold flex items-center gap-2">
                <span>对比正文加载中</span>
              </div>
              <p className="text-xs leading-relaxed">{diffResult.errorMessage}</p>
            </div>
          ) : (
            <div
              role="alert"
              className={`p-5 rounded-lg border space-y-2 ${
                paperLightMode
                  ? 'border-rose-300 bg-rose-50 text-rose-800'
                  : 'border-rose-500/35 bg-rose-950/40 text-rose-200'
              }`}
            >
              <div className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-500" />
                <span>错误码：{diffResult.errorCode}</span>
              </div>
              <p className="text-xs leading-relaxed">{diffResult.errorMessage}</p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <div
              className={`flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums px-1 ${
                paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
              }`}
            >
              <div>
                变化的章节：
                <span
                  className={`font-sans ml-1 ${
                    paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F4F3EE]'
                  }`}
                >
                  {diffResult.changedSections.length > 0
                    ? diffResult.changedSections.join(' · ')
                    : '无文本差异（内容 SHA-256 完全一致）'}
                </span>
              </div>
              <div>
                <span className={paperLightMode ? 'text-emerald-700' : 'text-emerald-400'}>
                  +{diffResult.addedCount} 行新增
                </span>
                {' · '}
                <span className={paperLightMode ? 'text-rose-700' : 'text-rose-400'}>
                  -{diffResult.removedCount} 行移除
                </span>
              </div>
            </div>

            {diffLayout === 'unified' ? (
              <div
                className={`rounded-lg border overflow-x-auto font-mono text-xs tabular-nums ${
                  paperLightMode
                    ? 'bg-white border-[#DDD9CF]'
                    : 'bg-[#161820] border-white/[0.08]'
                }`}
              >
                {diffResult.lines.map((line, idx) => (
                  <div
                    key={idx}
                    className={`flex items-start px-3 py-1 border-b ${
                      line.type === 'added'
                        ? paperLightMode
                          ? 'bg-emerald-500/12 text-emerald-950 border-[#E3E0D8]/60'
                          : 'bg-emerald-950/45 text-emerald-200 border-white/[0.05]'
                        : line.type === 'removed'
                          ? paperLightMode
                            ? 'bg-rose-500/12 text-rose-950 line-through opacity-85 border-[#E3E0D8]/60'
                            : 'bg-rose-950/45 text-rose-200 line-through opacity-85 border-white/[0.05]'
                          : paperLightMode
                            ? 'text-[#6E6A61] border-[#E3E0D8]/60'
                            : 'text-[#A5A9BC] border-white/[0.05]'
                    }`}
                  >
                    <span
                      className={`w-10 shrink-0 select-none ${
                        paperLightMode ? 'text-[#8A857C]' : 'text-[#6E7387]'
                      }`}
                    >
                      {line.oldLineNumber ?? ''}
                    </span>
                    <span
                      className={`w-10 shrink-0 select-none ${
                        paperLightMode ? 'text-[#8A857C]' : 'text-[#6E7387]'
                      }`}
                    >
                      {line.newLineNumber ?? ''}
                    </span>
                    <span className="w-5 shrink-0 select-none font-semibold">
                      {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                    </span>
                    <span className="whitespace-pre-wrap break-all">{line.content}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 font-mono text-xs tabular-nums">
                <div
                  className={`rounded-lg border overflow-hidden ${
                    paperLightMode
                      ? 'bg-white border-[#DDD9CF]'
                      : 'bg-[#161820] border-white/[0.08]'
                  }`}
                >
                  <div
                    className={`px-3 py-2 border-b font-semibold ${
                      paperLightMode
                        ? 'bg-[#F5F3EE] border-[#E3E0D8] text-[#4A463F]'
                        : 'bg-[#1D202C] border-white/[0.08] text-[#A5A9BC]'
                    }`}
                  >
                    基线版本：{effectiveFromRevId}
                  </div>
                  <div
                    className={`divide-y max-h-[540px] overflow-y-auto ${
                      paperLightMode ? 'divide-[#EFEDE7]' : 'divide-white/[0.05]'
                    }`}
                  >
                    {diffResult.lines
                      .filter((l) => l.type !== 'added')
                      .map((line, idx) => (
                        <div
                          key={idx}
                          className={`flex items-start px-3 py-1 ${
                            line.type === 'removed'
                              ? paperLightMode
                                ? 'bg-rose-500/12 text-rose-950'
                                : 'bg-rose-950/50 text-rose-200'
                              : paperLightMode
                                ? 'text-[#6E6A61]'
                                : 'text-[#A5A9BC]'
                          }`}
                        >
                          <span
                            className={`w-9 shrink-0 select-none ${
                              paperLightMode ? 'text-[#8A857C]' : 'text-[#6E7387]'
                            }`}
                          >
                            {line.oldLineNumber}
                          </span>
                          <span className="whitespace-pre-wrap break-all">
                            {line.content}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>

                <div
                  className={`rounded-lg border overflow-hidden ${
                    paperLightMode
                      ? 'bg-white border-[#DDD9CF]'
                      : 'bg-[#161820] border-white/[0.08]'
                  }`}
                >
                  <div
                    className={`px-3 py-2 border-b font-semibold ${
                      paperLightMode
                        ? 'bg-[#F5F3EE] border-[#E3E0D8] text-[#9A6A45]'
                        : 'bg-[#1D202C] border-white/[0.08] text-[#F0BA7B]'
                    }`}
                  >
                    对比目标：{effectiveToRevId}
                  </div>
                  <div
                    className={`divide-y max-h-[540px] overflow-y-auto ${
                      paperLightMode ? 'divide-[#EFEDE7]' : 'divide-white/[0.05]'
                    }`}
                  >
                    {diffResult.lines
                      .filter((l) => l.type !== 'removed')
                      .map((line, idx) => (
                        <div
                          key={idx}
                          className={`flex items-start px-3 py-1 ${
                            line.type === 'added'
                              ? paperLightMode
                                ? 'bg-emerald-500/12 text-emerald-950'
                                : 'bg-emerald-950/50 text-emerald-200'
                              : paperLightMode
                                ? 'text-[#6E6A61]'
                                : 'text-[#A5A9BC]'
                          }`}
                        >
                          <span
                            className={`w-9 shrink-0 select-none ${
                              paperLightMode ? 'text-[#8A857C]' : 'text-[#6E7387]'
                            }`}
                          >
                            {line.newLineNumber}
                          </span>
                          <span className="whitespace-pre-wrap break-all">
                            {line.content}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

