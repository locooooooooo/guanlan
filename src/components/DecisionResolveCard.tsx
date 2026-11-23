import React, { useMemo, useState } from 'react';
import type { StatementDetailDTO } from '../services/apiTypes';
import {
  loadDecisionIdentityMemory,
  rememberDecisionIdentity,
  type DecisionBlock,
  type DecisionResolveFormValues,
  type DecisionIdentityMemory,
} from '../utils/decisionBlocks';

/**
 * Inline 拍板卡点表单（PRD 3.3 / 方案 F5）：正文原位渲染的可交互卡点块。
 *
 * 控件（PRD 3.3 逐项）：
 *  - 决定：下拉单选（预设=文档「可选方案/推荐理由」提取 ∪ 服务端 statement.options，
 *    调用方合并）+「自定义…」文本输入；
 *  - 确认人 / 角色：自由文本 + 最近值点选（datalist；无成员数据源，方案登记偏差——
 *    PRD 的「成员列表点选」待身份数据源引入），localStorage 记忆（decisionBlocks）；
 *  - 生效范围与日期：影响范围标签 chips（全量专项 / 仅当前分支）+ 自定义文本、
 *    原生 date 选择器（YYYY-MM-DD）。
 *
 * 提交纪律：仅有服务端陈述（statement）时才可提交——回写 .md 是后端拍板 job
 * （CAS 占位符替换、状态变 [Px - 已确认]），前端绝不本地写文件；
 * 无陈述时表单保持可填写但提交禁用并如实提示（诚实降级，不伪造可用性）。
 */

/** 影响范围标签预设（PRD 3.3 例词） */
const EFFECTIVE_SCOPE_PRESETS: readonly string[] = ['全量专项', '仅当前分支'];
/** 自定义决定选项哨兵值 */
const CUSTOM_OPTION = '__custom__';

export interface DecisionResolveCardProps {
  block: DecisionBlock;
  /** 服务端陈述（GET /statements 按行号匹配）；null=本地模式（提交禁用） */
  statement: StatementDetailDTO | null;
  /** 决定下拉预设选项（调用方合并文档提取与 statement.options） */
  presetOptions: readonly string[];
  recommendation?: string | null;
  impactBlocked?: readonly string[] | null;
  impactAllowed?: readonly string[] | null;
  paperLightMode: boolean;
  /** 父级回写流进行中（202 已受理，轮询未终态） */
  submitting: boolean;
  /** 提交回调：参数为表单值（载荷组装走 buildDecisionResolvePayload 单一出口） */
  onSubmit: (values: DecisionResolveFormValues) => void;
  /** 父级结果提示（error=端点/轮询失败；ok=回写成功；conflict=CAS 冲突存草案） */
  notice?: { kind: 'error' | 'ok' | 'conflict'; message: string } | null;
  /** conflict 提示的「查看版本对比」动作（ReaderView 切 diff_versions 子模式） */
  onShowDiff?: () => void;
}

const DecisionResolveCard: React.FC<DecisionResolveCardProps> = ({
  block,
  statement,
  presetOptions,
  recommendation,
  impactBlocked,
  impactAllowed,
  paperLightMode,
  submitting,
  onSubmit,
  notice,
  onShowDiff,
}) => {
  const [identity, setIdentity] = useState<DecisionIdentityMemory>(() =>
    loadDecisionIdentityMemory()
  );
  const [choice, setChoice] = useState<string>('');
  const [customDecision, setCustomDecision] = useState<string>('');
  const [confirmer, setConfirmer] = useState<string>(
    statement?.confirmer_hint || identity.confirmers[0] || ''
  );
  const [role, setRole] = useState<string>(identity.roles[0] || '');
  const [scope, setScope] = useState<string>('');
  const [effectiveDate, setEffectiveDate] = useState<string>('');

  const listId = useMemo(() => `decision-identity-${block.line}`, [block.line]);
  const customMode = choice === CUSTOM_OPTION;
  const decisionValue = customMode ? customDecision : choice;

  // 提交门禁：决定必填；确认人必填（回写占位符需要）；有服务端陈述才可提交
  const canSubmit =
    !!statement && !submitting && decisionValue.trim().length > 0 && confirmer.trim().length > 0;
  // E04：「已知悉」快捷放行——仍强制走后端 CAS 写回原 .md、扣减未决并解锁下游，绝不跳过写盘
  const canAcknowledge = !!statement && !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const values: DecisionResolveFormValues = {
      decision: decisionValue,
      confirmer,
      role,
      effectiveScope: scope,
      effectiveDate,
      note: '',
    };
    // 记忆随提交更新（下次点选预填）；载荷组装由父级走 buildDecisionResolvePayload 单一出口
    setIdentity(rememberDecisionIdentity(identity, confirmer, role));
    onSubmit(values);
  };

  const handleAcknowledge = () => {
    if (!canAcknowledge) return;
    const effectiveConfirmer =
      confirmer.trim() || statement?.confirmer_hint || identity.confirmers[0] || '人工确认';
    const values: DecisionResolveFormValues = {
      decision: '已知悉（人工确认放行）',
      confirmer: effectiveConfirmer,
      role,
      effectiveScope: scope || '全量专项',
      effectiveDate,
      note: '已知悉快速放行',
    };
    setConfirmer(effectiveConfirmer);
    setIdentity(rememberDecisionIdentity(identity, effectiveConfirmer, role));
    onSubmit(values);
  };

  const cardBorder = paperLightMode ? 'border-[#E3D9C8]' : 'border-[#3A3730]';
  const cardBg = paperLightMode ? 'bg-[#FBF7EF]' : 'bg-[#28241F]';
  const labelClass =
    'text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] shrink-0';
  const inputClass = `rounded border px-2 py-1 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] bg-transparent focus:outline-none focus:border-[color:var(--stage-ink-decision)] ${cardBorder} text-[color:var(--ink-strong)]`;
  const chipBase =
    'rounded-full px-2.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] transition-colors cursor-pointer border ';

  return (
    <div
      data-decision-card={block.line}
      className={`my-3 rounded-lg border ${cardBorder} ${cardBg} p-3.5`}
      aria-label={`拍板卡点：${block.title || block.priority}`}
    >
      {/* 标题行：优先级 + 状态 + 卡点标题 */}
      <div className="flex flex-wrap items-center gap-2 mb-2.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--stage-ink-decision-text)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_12%,transparent)] tabular-nums`}
        >
          {block.priorities.join('/')} · 待拍板
        </span>
        <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium text-[color:var(--ink-strong)] truncate">
          {block.title || '（未命名卡点）'}
        </span>
        {statement && (
          <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-[color:var(--ink-soft)] truncate">
            {statement.code}
          </span>
        )}
      </div>

      {/* 决定：预设下拉 + 自定义输入（PRD 3.3「自动提取选项 + 支持自定义」） */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className={labelClass}>决定</span>
        {!customMode ? (
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            data-decision-choice={block.line}
            aria-label="拍板决定（预设选项）"
            className={`${inputClass} min-w-[14em]`}
          >
            <option value="" disabled>
              选择决定…
            </option>
            {presetOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
            <option value={CUSTOM_OPTION}>自定义…</option>
          </select>
        ) : (
          <input
            type="text"
            value={customDecision}
            onChange={(e) => setCustomDecision(e.target.value)}
            data-decision-custom={block.line}
            aria-label="拍板决定（自定义输入）"
            placeholder="填写决定…"
            className={`${inputClass} w-56`}
          />
        )}
        {!customMode && (
          <button
            type="button"
            onClick={() => setChoice(CUSTOM_OPTION)}
            className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
          >
            自定义…
          </button>
        )}
        {customMode && (
          <button
            type="button"
            onClick={() => {
              setChoice('');
              setCustomDecision('');
            }}
            className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
          >
            改用预设
          </button>
        )}
        {recommendation && (
          <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--stage-ink-deliver-text)] truncate max-w-[16em]">
            推荐：{recommendation}
          </span>
        )}
      </div>

      {/* 确认人 / 角色：自由文本 + 最近值点选（datalist 记忆；无成员数据源——偏差登记） */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className={labelClass}>确认人</span>
        <input
          type="text"
          value={confirmer}
          onChange={(e) => setConfirmer(e.target.value)}
          list={listId}
          data-decision-confirmer={block.line}
          aria-label="拍板确认人"
          placeholder="填写或从最近使用中选择…"
          className={`${inputClass} w-44`}
        />
        <span className={labelClass}>角色</span>
        <input
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          list={listId}
          data-decision-role={block.line}
          aria-label="拍板角色（可选）"
          placeholder="可选"
          className={`${inputClass} w-36`}
        />
        <datalist id={listId}>
          {identity.confirmers.map((c) => (
            <option key={`c-${c}`} value={c} />
          ))}
          {identity.roles.map((r) => (
            <option key={`r-${r}`} value={r} />
          ))}
        </datalist>
      </div>

      {/* 生效范围与日期：影响范围标签 chips + 自定义 + 原生日期选择器 */}
      <div className="flex flex-wrap items-center gap-2 mb-2.5">
        <span className={labelClass}>生效范围</span>
        {EFFECTIVE_SCOPE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={scope === preset}
            onClick={() => setScope((prev) => (prev === preset ? '' : preset))}
            className={
              chipBase +
              (scope === preset
                ? 'border-[color:var(--stage-ink-decision)] text-[color:var(--stage-ink-decision-text)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)]'
                : `text-[color:var(--ink-soft)] ${cardBorder}`)
            }
          >
            {preset}
          </button>
        ))}
        <input
          type="text"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label="影响范围（自定义）"
          placeholder="或自定义…"
          className={`${inputClass} w-36`}
        />
        <span className={labelClass}>生效日期</span>
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
          data-decision-date={block.line}
          aria-label="生效日期"
          className={`${inputClass} w-40`}
        />
      </div>

      {/* 影响面摘要（statement.impact_blocked/impact_allowed 两字段不合并——建议 8） */}
      {(impactBlocked?.length ?? 0) + (impactAllowed?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-2.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] tabular-nums">
          {!!impactBlocked?.length && <span>阻塞 {impactBlocked.length} 项事项</span>}
          {!!impactAllowed?.length && <span>放行 {impactAllowed.length} 项核对</span>}
        </div>
      )}

      {/* 提交行：三步原子操作提示 + 禁用原因（诚实降级） */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          data-decision-submit={block.line}
          onClick={handleSubmit}
          disabled={!canSubmit}
          title={
            !statement
              ? '未匹配到服务端陈述（statement），拍板回写需本地服务端点支持'
              : canSubmit
                ? `回写 ${block.priorities.join('/')} 拍板结果至源文件（后端 CAS）`
                : '请先填写决定与确认人'
          }
          className={`rounded-md px-3.5 py-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium transition-colors ${
            canSubmit
              ? 'cursor-pointer bg-[color:var(--stage-ink-decision)] text-white hover:opacity-90'
              : 'cursor-not-allowed bg-[color:color-mix(in_srgb,var(--ink-soft)_14%,transparent)] text-[color:var(--ink-soft)]'
          }`}
        >
          {submitting ? '拍板回写中…' : '确认拍板'}
        </button>
        <button
          type="button"
          data-decision-ack={block.line}
          onClick={handleAcknowledge}
          disabled={!canAcknowledge}
          title={
            !statement
              ? '未匹配到服务端陈述（statement），无法写回源文件'
              : '以「已知悉（人工确认放行）」原位写回 .md、扣减未决计数并自动解锁下游事项'
          }
          className={`rounded-md border px-3 py-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium transition-colors ${
            canAcknowledge
              ? 'cursor-pointer border-[color:var(--stage-ink-deliver)] text-[color:var(--stage-ink-deliver-text)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_8%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_16%,transparent)]'
              : 'cursor-not-allowed border-[color:var(--glass-hairline)] text-[color:var(--ink-soft)] opacity-60'
          }`}
        >
          已知悉
        </button>
        {!statement && (
          <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
            本地服务未提供该卡点的陈述（statement）——表单可预填，回写待端点可用
          </span>
        )}
        {statement && !canSubmit && (
          <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
            请先填写决定与确认人
          </span>
        )}
      </div>

      {/* 结果提示（父级回流）：ok / conflict（CAS 冲突存草案 + 查看对比）/ error */}
      {notice && (
        <div
          className={`mt-2.5 rounded border px-2.5 py-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] ${
            notice.kind === 'ok'
              ? 'border-[color:var(--stage-ink-deliver)] text-[color:var(--stage-ink-deliver-text)]'
              : 'border-[color:var(--stage-ink-anomaly)] text-[color:var(--stage-ink-anomaly-text)]'
          }`}
          role="status"
        >
          <span>{notice.message}</span>
          {notice.kind === 'conflict' && onShowDiff && (
            <button
              type="button"
              onClick={onShowDiff}
              className="ml-2 underline underline-offset-2 cursor-pointer"
            >
              查看版本对比
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default DecisionResolveCard;
