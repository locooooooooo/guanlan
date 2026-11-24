import React from 'react';
import { ArrowUpRight, Compass, Layers, Scale } from 'lucide-react';
import type { DecisionStatus, FileFormat } from '../types/guanlan';
// 五阶段槽位与阶段语义色全部复用 taskPackages 既有单一出口（组件自身零造数）
import { STAGE_ACCENT, STAGE_SLOT_ORDER } from '../utils/taskPackages';
import type { StageRole } from '../utils/taskPackages';
import { cleanDisplayText } from '../utils/displayText';

// ============================================================
// 首页专题橱窗 · 横排 2 张微渐变专题卡（组件契约 C1，签名冻结）
//   卡 A：淡琥珀（--feature-grad-amber）「待你拍板的决策」——N 由 HomeView 按
//         DecisionRadar.tsx:94-105 同口径计算后传入，组件只渲染；
//   卡 B：淡蓝紫（--feature-grad-blue）「今日最活跃专项」——activePackage 由
//         HomeView 近 7 天窗口 eventCount 最高者物化成 FeaturedPackageInfo；
//   斜叠微型卡数据（卡 B 图纸 dataUri / badgeLine）来自 HomeView（首页票 R5 +
//   橱窗工票 T4 接线：dataUri=该专项最新 SVG 封面、badgeLine=packageBadgeLine
//   真实派生徽标），组件只渲染；
//   斜叠排版封面（工票 T1/T4）：无 SVG 时走「阶段状态微缩卡」——徽标 + 五段迷你
//   进度排版件，不放正文文字（消灭斜叠纸片与正文区的文字复读与占位复读）。
//   渐变头图按令牌契约由组件叠 background-image：var(--feature-grad-*)，
//   卡基座走 depth-2-card + depth-2-card-featured（v0.8 三层景深工具类）。
// ============================================================

export interface FeaturedDecisionItem {
  decisionId: string;
  question: string;
  status: DecisionStatus;
}

export interface FeaturedPackageInfo {
  id: string;
  name: string;
  stage: StageRole;
  docCount: number;
  awaitingAcceptance: number;
  /** 版本·阶段徽标行（工票 T4 增补，可选字段不破冻结签名）：HomeView 调
      taskPackages.packageBadgeLine(activePackage) 真实派生（如「v8 · 待用户验收」）；
      空串 = 版本与阶段短语双无（数据层契约），斜叠排版封面只渲染进度轨降级，不造占位 */
  badgeLine?: string;
  cover?: {
    fileId: string;
    title: string;
    format: FileFormat;
    dataUri?: string;
    /** C1 冻结字段保留：工票 T1 后斜叠封面不再渲染正文文字，当前无渲染消费
        （数据链仍由 HomeView 真实填充；是否裁撤留待后续票确认消费者后定夺） */
    conclusion: string;
  };
}

export interface FeaturedFocusCardsProps {
  /** 待拍板决策（HomeView 按雷达同口径过滤取前 2；组件自身零造数） */
  decisionItems: FeaturedDecisionItem[];
  decisionCount: number;
  /** 今日最活跃专项（HomeView 近 7 天窗口计算；无活跃专项为 null → 渲染诚实空态） */
  activePackage: FeaturedPackageInfo | null;
  onOpenDecision: (decisionId: string) => void;
  onOpenPackageBoard: () => void;
}

/** 阶段徽标胶囊样式（与 TaskPackageGallery 封面区同名同款，互为镜像——
    FiveStageRail 双文件既有先例；全 var(--token)，无 hex/rgba） */
const STAGE_BADGE_PILL_CLASS =
  'w-fit max-w-full truncate rounded-full bg-[color:var(--depth-2-bg)] px-2 py-0.5 ' +
  'text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-strong)] ' +
  'shadow-[var(--depth-2-shadow)]';

/** 五阶段迷你进度轨（aria-hidden 纯装饰）：到达段按槽位阶段色填充，未达段走微淡底轨。
    U10 微光细节：未达段底轨由硬写 rgba 改收编 --glass-hairline 令牌（同 8% 墨相，
    与全站描边/底轨同一色系，零新造色值）。 */
const FiveStageRail: React.FC<{ stage: StageRole; className?: string }> = ({ stage, className }) => {
  const reachedRank = STAGE_SLOT_ORDER.indexOf(stage);
  return (
    <span className={`flex items-center gap-1 ${className ?? ''}`} aria-hidden="true">
      {STAGE_SLOT_ORDER.map((role, i) => (
        <span
          key={role}
          className="h-1.5 flex-1 rounded-full"
          style={{
            backgroundColor: i <= reachedRank ? STAGE_ACCENT[role] : 'var(--glass-hairline)',
          }}
        />
      ))}
    </span>
  );
};

/** 斜叠微型决策卡（V07 零孤字精修）：上下分离对角微错位（layer=0 上左主卡 h=70、layer=1 下右副卡 h=44），
 *  两卡垂直零重叠（4px 呼吸间距），彻底消灭后卡文字被前卡裁切漏出孤字；保留 glx-fan-front / glx-fan-back 与扫光。 */
const MiniDecisionCard: React.FC<{
  item: FeaturedDecisionItem;
  layer: 0 | 1;
  onOpenDecision: (decisionId: string) => void;
}> = ({ item, layer, onOpenDecision }) => {
  const isConflict = item.status === '来源不一致';
  const accentColor = isConflict ? 'var(--stage-ink-anomaly)' : 'var(--stage-ink-decision)';
  const statusTextColor = isConflict
    ? 'var(--stage-ink-anomaly-text)'
    : 'var(--stage-ink-decision-text)';
  const posClass =
    layer === 0
      ? 'left-0 top-0.5 z-[2] glx-fan-front'
      : 'right-0 bottom-0.5 z-[1] glx-fan-back';
  const cleanQuestion = cleanDisplayText(item.question) || item.question;
  return (
    <div className={`absolute ${posClass}`} data-featured-mini-layer={layer}>
      <button
        type="button"
        onClick={() => onOpenDecision(item.decisionId)}
        title={`${item.status} · ${cleanQuestion}`}
        aria-label={`查看决策：${cleanQuestion}`}
        // U10 微光细节：斜叠微卡接入既有 .glx-sheen-card 扫光（reduce 整层隐藏的
        // 已登记类，零新增降级欠账），悬停时箭头同步点亮形成「有路可走」的微光回应
        className={`group/mini glx-sheen-card flex w-[184px] cursor-pointer flex-col justify-between overflow-hidden rounded-[12px] border border-border/80 bg-card/95 text-left shadow-[0_6px_18px_-6px_rgba(38,36,61,0.14)] dark:shadow-[0_8px_20px_-6px_rgba(0,0,0,0.48)] hover:border-[color:color-mix(in_srgb,var(--accent-wave)_45%,transparent)] hover:shadow-[0_12px_24px_-6px_rgba(168,74,26,0.22)] motion-safe:transition-shadow ${
          layer === 0 ? 'h-[70px] px-2.5 py-2' : 'h-[44px] px-2.5 py-1.5'
        }`}
      >
        {layer === 0 ? (
          <>
            <div className="flex items-center justify-between gap-1.5">
              <span
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium"
                style={{
                  backgroundColor: `color-mix(in srgb, ${accentColor} 14%, transparent)`,
                  color: statusTextColor,
                }}
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: accentColor }}
                  aria-hidden="true"
                />
                {item.status}
              </span>
              {/* U10：--ink-faint 仅作图形底态（图形豁免合法），hover 点亮 --accent-iris-deep */}
              <ArrowUpRight
                className="size-3 shrink-0 text-[color:var(--ink-faint)] motion-safe:transition-colors group-hover/mini:text-[color:var(--accent-iris-deep)]"
                aria-hidden="true"
              />
            </div>
            <span className="line-clamp-2 text-[11px] leading-[15px] font-medium text-[color:var(--ink-strong)]">
              {cleanQuestion}
            </span>
          </>
        ) : (
          <div className="flex h-full items-center gap-1.5 min-w-0">
            <span
              className="size-1.5 rounded-full shrink-0"
              style={{ backgroundColor: accentColor }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] leading-[15px] font-medium text-[color:var(--ink-strong)]">
              {cleanQuestion}
            </span>
            <ArrowUpRight
              className="size-3 shrink-0 text-[color:var(--ink-faint)] motion-safe:transition-colors group-hover/mini:text-[color:var(--accent-iris-deep)]"
              aria-hidden="true"
            />
          </div>
        )}
      </button>
    </div>
  );
};

const FeaturedFocusCards: React.FC<FeaturedFocusCardsProps> = ({
  decisionItems,
  decisionCount,
  activePackage,
  onOpenDecision,
  onOpenPackageBoard,
}) => {
  const coverImage = activePackage?.cover?.dataUri ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 卡 A：待拍板决策（简洁实体专题卡）。数字锚点 data-feature-count="decision" */}
      <section
        data-feature-card="decision"
        className="group glx-sheen-card glx-fan-stage depth-2-card depth-2-card-featured relative p-5 sm:p-6 bg-card"
      >
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-ctl)] bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)] text-[color:var(--accent-wave)]"
              >
                <Scale className="size-4" />
              </span>
              <span className="text-[11px] leading-none font-semibold tracking-[0.06em] text-[color:var(--accent-wave)]">
                决策焦点
              </span>
            </div>

            <div>
              <h2 className="flex flex-wrap items-baseline gap-2 text-[17px] leading-[24px] font-semibold tracking-tight text-[color:var(--ink-strong)]">
                <span>待拍板</span>
                <span className="inline-flex items-baseline gap-0.5 font-serif-claude text-[28px] leading-none font-bold tabular-nums text-[color:var(--accent-wave)]">
                  <span data-feature-count="decision">{decisionCount}</span>
                  <span className="font-sans text-[12px] font-medium text-[color:var(--ink-soft)]">项</span>
                </span>
              </h2>
              <p className="mt-1 text-[12px] leading-[18px] text-[color:var(--ink-soft)]">
                {decisionCount > 0 ? '点右侧卡片直达依据原文' : '全部已定案，当前无阻塞'}
              </p>
            </div>
          </div>

          {/* 斜叠微型决策卡舞台：上下分离错位（零重叠、零孤字截断） */}
          <div className="relative h-[120px] w-[204px] shrink-0 hidden sm:block">
            {decisionItems.length === 0 ? (
              <div
                aria-hidden="true"
                className="glx-fan-front absolute right-4 top-3 flex h-[96px] w-[152px] flex-col items-center justify-center gap-1.5 rounded-[12px] border border-border/80 bg-card/90 p-3 shadow-sm"
              >
                <span className="size-2 rounded-full bg-[color:var(--stage-ink-deliver)]" />
                <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]">
                  暂无待拍板决策
                </span>
              </div>
            ) : (
              decisionItems
                .slice(0, 2)
                .map((item, i) => (
                  <MiniDecisionCard
                    key={item.decisionId}
                    item={item}
                    layer={i === 0 ? 0 : 1}
                    onOpenDecision={onOpenDecision}
                  />
                ))
            )}
          </div>
        </div>
      </section>

      {/* 卡 B：今日最活跃专项（薰衣草琉璃专题卡），整卡点击 = 打开任务包看板。
          数字锚点 data-feature-count="package"（待验收 N，GL-01 口径） */}
      <button
        type="button"
        data-feature-card="package"
        onClick={onOpenPackageBoard}
        aria-label={
          activePackage ? `打开任务包看板：${activePackage.name}` : '打开任务包看板'
        }
        className="group glx-sheen-card glx-fan-stage depth-2-card depth-2-card-featured depth-2-card-hover relative flex w-full cursor-pointer items-center justify-between gap-4 p-5 sm:p-6 text-left bg-card"
      >
        <span className="relative flex min-w-0 flex-1 flex-col justify-between gap-3">
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-ctl)] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-deep)]"
            >
              {activePackage ? <Layers className="size-4" /> : <Compass className="size-4" />}
            </span>
            <span className="text-[11px] leading-none font-semibold tracking-[0.06em] text-[color:var(--accent-iris-ink)]">
              活跃专项
            </span>
          </span>

          <span className="block min-w-0">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-[17px] leading-[24px] font-semibold tracking-tight text-[color:var(--ink-strong)]">
                {activePackage ? activePackage.name : '暂无活跃专项'}
              </span>
              <ArrowUpRight
                className="size-4 shrink-0 text-[color:var(--accent-iris-deep)] opacity-70 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 motion-safe:transition-all"
                aria-hidden="true"
              />
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-[18px] text-[color:var(--ink-soft)]">
              {activePackage ? (
                <>
                  <strong className="font-semibold text-[color:var(--ink-strong)]">{activePackage.stage}</strong>
                  <span aria-hidden="true" className="opacity-35">·</span>
                  <span className="font-mono tabular-nums text-[color:var(--ink-soft)]">
                    {activePackage.docCount} 份
                  </span>
                  <span aria-hidden="true" className="opacity-35">·</span>
                  <span>
                    待验收{' '}
                    <span data-feature-count="package" className="font-mono font-semibold tabular-nums text-[color:var(--accent-iris-ink)]">
                      {activePackage.awaitingAcceptance}
                    </span>
                  </span>
                </>
              ) : (
                '点击浏览全部专项看板'
              )}
            </span>
          </span>
        </span>

        {/* 右侧微缩专项卡（呈现真实徽标、资产量与五段进度轨，无假占位条） */}
        <span className="relative h-[120px] w-[184px] shrink-0 hidden sm:block" aria-hidden="true">
          <span className="glx-fan-front absolute right-2 top-2 flex h-[100px] w-[164px] flex-col justify-between overflow-hidden rounded-[var(--r-block)] border border-border bg-card p-3 shadow-xs">
            {coverImage ? (
              <img
                src={coverImage}
                alt=""
                loading="lazy"
                className="h-full w-full rounded-[var(--r-ctl)] object-contain"
              />
            ) : activePackage ? (
              <>
                <span className="flex items-center justify-between gap-1.5">
                  {activePackage.badgeLine ? (
                    <span className={STAGE_BADGE_PILL_CLASS}>{activePackage.badgeLine}</span>
                  ) : (
                    <span className="font-mono text-[length:var(--text-micro)] font-medium text-[color:var(--accent-iris-ink)]">
                      {activePackage.stage}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[length:var(--text-micro)] font-medium tabular-nums text-[color:var(--ink-soft)]">
                    {activePackage.docCount} 份
                  </span>
                </span>
                <span className="block truncate text-[length:var(--text-ui)] font-semibold leading-tight text-[color:var(--ink-strong)]">
                  {activePackage.name}
                </span>
                <FiveStageRail stage={activePackage.stage} />
              </>
            ) : (
              <>
                <span className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] px-2 py-0.5 font-mono text-[length:var(--text-micro)] font-medium text-[color:var(--accent-iris-ink)]">
                    档案全览
                  </span>
                </span>
                <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                  查看全部专项与进度
                </span>
                <span className="flex items-center gap-1">
                  {STAGE_SLOT_ORDER.map((role) => (
                    <span
                      key={role}
                      className="h-1 flex-1 rounded-full opacity-45"
                      style={{ backgroundColor: STAGE_ACCENT[role] }}
                    />
                  ))}
                </span>
              </>
            )}
          </span>
        </span>
      </button>
    </div>
  );
};

export default FeaturedFocusCards;
