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

const INTERACTIVE_TRANSITION =
  'motion-safe:[transition:background-color_var(--dur-1)_var(--ease-fade),border-color_var(--dur-1)_var(--ease-fade),color_var(--dur-1)_var(--ease-fade),box-shadow_var(--dur-1)_var(--ease-fade),transform_var(--dur-1)_var(--ease-fade)]';

const DISABLED_STATES = 'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none';


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
  primary: cx(
    'bg-[color:var(--btn-primary-bg)] text-[color:var(--paper-on-ink)]',
    'shadow-xs',
    'enabled:hover:bg-[color:var(--btn-primary-bg-hover)]',
    'enabled:active:bg-[color:var(--btn-primary-bg-active)] enabled:active:[transform:translateY(0.5px)]',
  ),
  secondary: cx(
    'border bg-[color:var(--btn-secondary-bg)] border-[color:var(--btn-secondary-border)] text-[color:var(--ink-strong)]',
    'shadow-2xs',
    'enabled:hover:bg-[color:var(--btn-secondary-bg-hover)] enabled:hover:border-[color:var(--btn-secondary-border-hover)]',
    'enabled:active:bg-[color:var(--btn-secondary-bg-active)] enabled:active:border-[color:var(--btn-secondary-border-active)] enabled:active:[transform:translateY(0.5px)]',
  ),
  ghost: cx(
    'bg-transparent text-[color:var(--ink-soft)]',
    'enabled:hover:bg-[color:var(--btn-ghost-bg-hover)] enabled:hover:text-[color:var(--ink-strong)]',
    'enabled:active:bg-[color:var(--btn-ghost-bg-active)]',
  ),
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


export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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


export interface TabItem {
  key: string;
  label: ReactNode;
  count?: number | string;
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

const SLIDER_BASE_WIDTH = 100;

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
    count: 'text-[color:var(--claude-ink-secondary)]',
    slider: 'bg-[color:var(--paper-dark)]',
  },
} as const;

const TAB_BASE = cx(
  'relative inline-flex h-[var(--ctl-h)] cursor-pointer select-none items-center gap-1.5 px-2',
  'text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-normal',
  'whitespace-nowrap shrink-0',
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


export type ChipStage = 'blueprint' | 'plan' | 'decision' | 'exec' | 'deliver' | 'anomaly';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  stage?: ChipStage;
  dot?: boolean;
  dotColor?: string;
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
