/**
 * 观澜 · 基础控件
 *
 * 设计纪律：
 * · 本文件不出现字面色值——一切颜色/尺寸/时长/缓动取自 src/index.css 的 :root
 *   令牌（组件级令牌段）；将来做暗色主题只换 :root，不触组件。
 * · 动效只走 transform 与 opacity（滑块位移/按下位移/淡入）；transition 仅限
 *   background/border/color/box-shadow/transform 这几个非布局属性的
 *   var(--dur-1) 微动，且全部包 motion-safe:——prefers-reduced-motion 下
 *   状态切换为瞬时（无过渡）。
 * · 不用 Tailwind 的 translate-* 与 scale-* 工具类做动画目标：Tailwind v4 里它们落在
 *   独立的 translate/scale 属性上，不在本组件的 transform 过渡清单内；
 *   位移一律写 [transform:...] 任意属性。
 * · 文案一律由调用方传入（中文为主）。
 * · 焦点环不在此重复声明——走 index.css 全局 :focus-visible 规则。
 */
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

type ClassPart = string | false | null | undefined;

const cx = (...parts: ClassPart[]) => parts.filter(Boolean).join(' ');

/* 微动过渡：非布局属性的 --dur-1 过渡。除 background/box-shadow/transform 外，
   同步包含 border-color 与 color——secondary/danger 在交互态会变边框透明度、
   ghost 会变文字色，纳入过渡可避免 120ms 微动里突跳，且二者均为纯重绘属性。 */
const INTERACTIVE_TRANSITION =
  'motion-safe:[transition:background-color_var(--dur-1)_var(--ease-fade),border-color_var(--dur-1)_var(--ease-fade),color_var(--dur-1)_var(--ease-fade),box-shadow_var(--dur-1)_var(--ease-fade),transform_var(--dur-1)_var(--ease-fade)]';

const DISABLED_STATES = 'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none';

/* ══════════════════════════════════════════════════════════════════════════
   Button
   变体 primary / secondary / ghost / danger × default/hover/active/disabled；
   尺寸 md=--ctl-h 28px / sm=--ctl-h-sm 24px；fullWidth=全宽形态（以 prop 控制）。
   ══════════════════════════════════════════════════════════════════════════ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

const BUTTON_BASE = cx(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer',
  'h-[var(--ctl-h)] rounded-[var(--r-ctl)] px-3.5',
  'text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium',
  '[&>svg]:size-3.5 [&>svg]:shrink-0',
  INTERACTIVE_TRANSITION,
  DISABLED_STATES,
);

const BUTTON_SIZE_SM = 'h-[var(--ctl-h-sm)] rounded-[var(--r-ctl)] px-2.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)]';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /* 主：澜墨实心，克制阴影与明确四态 */
  primary: cx(
    'bg-[color:var(--btn-primary-bg)] text-[color:var(--paper-on-ink)]',
    'shadow-xs',
    'enabled:hover:bg-[color:var(--btn-primary-bg-hover)]',
    'enabled:active:bg-[color:var(--btn-primary-bg-active)] enabled:active:[transform:translateY(0.5px)]',
  ),
  /* 次：中性实底描边，克制阴影与明确四态 */
  secondary: cx(
    'border bg-[color:var(--btn-secondary-bg)] border-[color:var(--btn-secondary-border)] text-[color:var(--ink-strong)]',
    'shadow-2xs',
    'enabled:hover:bg-[color:var(--btn-secondary-bg-hover)] enabled:hover:border-[color:var(--btn-secondary-border-hover)]',
    'enabled:active:bg-[color:var(--btn-secondary-bg-active)] enabled:active:border-[color:var(--btn-secondary-border-active)] enabled:active:[transform:translateY(0.5px)]',
  ),
  /* 幽灵：透明无边；hover 浮墨底＋字升 strong */
  ghost: cx(
    'bg-transparent text-[color:var(--ink-soft)]',
    'enabled:hover:bg-[color:var(--btn-ghost-bg-hover)] enabled:hover:text-[color:var(--ink-strong)]',
    'enabled:active:bg-[color:var(--btn-ghost-bg-active)]',
  ),
  /* 危险（描边式）：exec -text 深档字＋exec 45% 边；hover/active 叠语义淡底 */
  danger: cx(
    'border bg-transparent border-[color:var(--btn-danger-border)] text-[color:var(--btn-danger-ink)]',
    'enabled:hover:bg-[color:var(--btn-danger-bg-hover)]',
    'enabled:active:bg-[color:var(--btn-danger-bg-active)]',
  ),
};

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        BUTTON_BASE,
        size === 'sm' && BUTTON_SIZE_SM,
        BUTTON_VARIANTS[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   IconButton
   32×32 r6 方玻璃；子节点 svg 由 CSS 钉成 16px/1.5px 描边（lucide 线性图标
   直接作 children 传入即可，无需各自带 size/strokeWidth）；color 走文字色链。
   ══════════════════════════════════════════════════════════════════════════ */

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 无障碍名称（必填：图标钮无可见文字） */
  label: string;
}

const ICON_BUTTON_BASE = cx(
  'inline-flex select-none items-center justify-center',
  'h-[var(--ctl-icon)] w-[var(--ctl-icon)] rounded-[var(--r-ctl)]',
  'border bg-[color:var(--btn-icon-bg)] border-[color:var(--glass-hairline)] text-[color:var(--ink-soft)]',
  '[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:[stroke-width:1.5]',
  INTERACTIVE_TRANSITION,
  'enabled:hover:bg-[color:var(--btn-icon-bg-hover)] enabled:hover:text-[color:var(--ink-strong)]',
  'enabled:active:bg-[color:var(--btn-icon-bg-active)]',
  DISABLED_STATES,
);

export function IconButton({ label, className, type = 'button', children, ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} className={cx(ICON_BUTTON_BASE, className)} {...rest}>
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Tabs
   激活语法＝「标线为界」：墨字＋2px 标线，永不填充。标线是共享滑块：
   容器+按钮 refs 测量，基准宽 100px，transform = translateX(偏移) scaleX(宽/100)，
   180ms var(--ease-spring)，不动画 left/width（零布局位移）。
   theme='dark' 只换 CSS 变量取值，不动结构（暗画布 chrome 与浅色双端同构）。
   未读点：6px --accent-wave 恒 α1.0；光环 ping 一次 600ms（motion.css .glx-ping-once）
   由调用方叠加，本件只渲染静态核。
   键盘：role=tablist + roving tabindex + ←/→/Home/End（选中随焦点移动）。
   ══════════════════════════════════════════════════════════════════════════ */

export interface TabItem {
  key: string;
  label: ReactNode;
  /** 计数徽标：mono 500 + tabular-nums，色 --ink-soft（暗域 --claude-ink-secondary） */
  count?: number | string;
  /** 未读点（6px 澜·未读） */
  dot?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  theme?: 'light' | 'dark';
  ariaLabel?: string;
  className?: string;
}

const SLIDER_BASE_WIDTH = 100; // px，scaleX 基准宽

const TAB_THEME = {
  light: {
    idle: cx(
      'text-[color:var(--ink-soft)]',
      'enabled:hover:text-[color:var(--ink-strong)] enabled:hover:[box-shadow:inset_0_-1px_0_var(--tab-hover-line)]',
    ),
    selected: 'text-[color:var(--ink-strong)] font-semibold',
    count: 'text-[color:var(--ink-soft)]',
    slider: 'bg-[color:var(--ink-anchor)]',
  },
  dark: {
    idle: cx(
      'text-[color:var(--canvas-ink-idle)]',
      'enabled:hover:text-[color:var(--paper-dark)] enabled:hover:[box-shadow:inset_0_-1px_0_var(--tab-hover-line-dark)]',
    ),
    selected: 'text-[color:var(--paper-dark)] font-semibold',
    count: 'text-[color:var(--claude-ink-secondary)]', /* #A1A09A，暗画布次要文字色 */
    slider: 'bg-[color:var(--paper-dark)]',
  },
} as const;

const TAB_BASE = cx(
  'relative inline-flex h-[var(--ctl-h)] cursor-pointer select-none items-center gap-1.5 px-2',
  'text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-normal',
  'whitespace-nowrap shrink-0',
  /* hover 发丝线/字色微动；滑块自身的 180ms spring 在滑块元素上单独声明 */
  'motion-safe:[transition:color_var(--dur-1)_var(--ease-fade),box-shadow_var(--dur-1)_var(--ease-fade)]',
);

export function Tabs({
  items,
  active,
  onChange,
  theme = 'light',
  ariaLabel = '视图切换',
  className,
}: TabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [metric, setMetric] = useState<{ x: number; w: number } | null>(null);
  /* 首次测量落位前关闭过渡（inline transition:none 压过类），避免滑块从 0 飞入 */
  const [measured, setMeasured] = useState(false);

  const measure = useCallback(() => {
    const btn = buttonRefs.current.get(active);
    if (!btn) return;
    const x = btn.offsetLeft;
    const w = btn.offsetWidth;
    setMetric((prev) => (prev && prev.x === x && prev.w === w ? prev : { x, w }));
    setMeasured(true);
  }, [active]);

  useLayoutEffect(() => {
    measure();
  }, [measure, items]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(list);
    for (const el of buttonRefs.current.values()) ro.observe(el);
    let cancelled = false;
    /* 字体就位后标签宽度会变，补测一次（离线兜底场景同理） */
    document.fonts?.ready
      .then(() => {
        if (!cancelled) measure();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [measure, items]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((it) => it.key === active);
    let next = -1;
    if (event.key === 'ArrowRight') next = Math.min(items.length - 1, index + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next < 0 || next === index) return;
    event.preventDefault();
    onChange(items[next].key);
    buttonRefs.current.get(items[next].key)?.focus();
  };

  const tokens = TAB_THEME[theme];

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className={cx('relative inline-flex items-center gap-1', className)}
    >
      {items.map((it) => {
        const selected = it.key === active;
        return (
          <button
            key={it.key}
            ref={(el) => {
              if (el) buttonRefs.current.set(it.key, el);
              else buttonRefs.current.delete(it.key);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(it.key)}
            className={cx(TAB_BASE, selected ? tokens.selected : tokens.idle)}
          >
            <span className="relative inline-flex items-center">
              {it.label}
              {it.dot && (
                <span
                  aria-hidden
                  className="absolute -right-2 top-0 size-1.5 rounded-full bg-[color:var(--accent-wave)]"
                />
              )}
            </span>
            {it.count !== undefined && it.count !== null && (
              <span
                className={cx(
                  'font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium tabular-nums',
                  tokens.count,
                )}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
      <span
        aria-hidden
        className={cx(
          'pointer-events-none absolute bottom-0 left-0 block h-[2.5px] w-[100px] origin-left rounded-full',
          tokens.slider,
          'motion-safe:[transition:transform_var(--dur-2)_var(--ease-spring)]',
        )}
        style={{
          transform: metric
            ? `translateX(${metric.x}px) scaleX(${metric.w / SLIDER_BASE_WIDTH})`
            : 'translateX(0) scaleX(0)',
          transition: measured ? undefined : 'none',
        }}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Chip（筛选胶囊 + 状态胶囊）
   · 筛选胶囊：active 走薰衣草语法——iris 10% 底 + 60% 边 + --accent-iris-ink 字；
     idle 白玻璃淡底 + hairline 边 + --ink-soft 字。
   · 身份点：dot + dotColor（格式 md/svg/pdf、kind 身份色由调用方传画布泳道
     原值，避免色值硬编码进本文件）；stage 态的点用 graphic 原值。
   · stage（状态胶囊）：语义六色双层——底 graphic/10、边 graphic/45（hover /70）、
     字 -text 深档。文案中文字族走 sans，计数数字用 mono。
     文本档统一取 --text-ui（12px），mono 11px 仅留给计数徽标（--text-micro）。
   ══════════════════════════════════════════════════════════════════════════ */

export type ChipStage = 'blueprint' | 'plan' | 'decision' | 'exec' | 'deliver' | 'anomaly';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 胶囊激活态（筛选/格式/视图 chips） */
  active?: boolean;
  /** 语义状态胶囊；给定时覆盖 active 配色 */
  stage?: ChipStage;
  /** 6px 身份/状态点（aria-hidden 装饰） */
  dot?: boolean;
  /** 身份点色（格式/kind 泳道原值，由调用方传入） */
  dotColor?: string;
  /** 计数徽标：mono + tabular-nums */
  count?: number | string;
}

const STAGE_GRAPHIC: Record<ChipStage, string> = {
  blueprint: 'var(--stage-ink-blueprint)',
  plan: 'var(--stage-ink-plan)',
  decision: 'var(--stage-ink-decision)',
  exec: 'var(--stage-ink-exec)',
  deliver: 'var(--stage-ink-deliver)',
  anomaly: 'var(--stage-ink-anomaly)',
};

const STAGE_TEXT: Record<ChipStage, string> = {
  blueprint: 'var(--stage-ink-blueprint-text)',
  plan: 'var(--stage-ink-plan-text)',
  decision: 'var(--stage-ink-decision-text)',
  exec: 'var(--stage-ink-exec-text)',
  deliver: 'var(--stage-ink-deliver-text)',
  anomaly: 'var(--stage-ink-anomaly-text)',
};

const CHIP_BASE = cx(
  'inline-flex select-none items-center gap-1.5 whitespace-nowrap',
  'h-[var(--ctl-h-sm)] rounded-[var(--r-pill)] px-2.5 border',
  'text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium',
  INTERACTIVE_TRANSITION,
  DISABLED_STATES,
);

const CHIP_IDLE = cx(
  'bg-[color:var(--chip-idle-bg)] border-[color:var(--glass-hairline)] text-[color:var(--ink-soft)]',
  'enabled:hover:bg-[color:var(--chip-idle-bg-hover)] enabled:hover:text-[color:var(--ink-strong)]',
);

const CHIP_ACTIVE =
  'bg-[color:var(--chip-active-bg)] border-[color:var(--chip-active-border)] text-[color:var(--accent-iris-ink)]';

const CHIP_STAGE =
  'bg-[color:var(--chip-stage-bg)] border-[color:var(--chip-stage-line)] text-[color:var(--chip-stage-ink)] enabled:hover:border-[color:var(--chip-stage-line-hover)]';

export function Chip({
  active = false,
  stage,
  dot = false,
  dotColor,
  count,
  className,
  children,
  type = 'button',
  ...rest
}: ChipProps) {
  const stageStyle = stage
    ? ({
        '--chip-stage-bg': `color-mix(in srgb, ${STAGE_GRAPHIC[stage]} 10%, transparent)`,
        '--chip-stage-line': `color-mix(in srgb, ${STAGE_GRAPHIC[stage]} 45%, transparent)`,
        '--chip-stage-line-hover': `color-mix(in srgb, ${STAGE_GRAPHIC[stage]} 70%, transparent)`,
        '--chip-stage-ink': STAGE_TEXT[stage],
      } as CSSProperties)
    : undefined;

  return (
    <button
      type={type}
      aria-pressed={stage ? undefined : active}
      className={cx(CHIP_BASE, stage ? CHIP_STAGE : active ? CHIP_ACTIVE : CHIP_IDLE, className)}
      style={stageStyle}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{
            background: stage ? STAGE_GRAPHIC[stage] : (dotColor ?? 'currentColor'),
          }}
        />
      )}
      {children}
      {count !== undefined && count !== null && (
        <span className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}
