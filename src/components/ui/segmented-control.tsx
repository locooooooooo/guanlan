import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · SegmentedControl 滑动分段控制器（对齐 coss.com/ui）。
 * 自动测量激活项几何位置并以硬件加速滑块平滑移动；prefers-reduced-motion 下瞬时落位。
 */
export type SegmentedControlSize = 'default' | 'lg' | 'sm';

export const segmentedControlItemSizeClassNames: Record<SegmentedControlSize, string> = {
  default: 'h-7 px-2.5 text-xs',
  lg: 'h-8 px-3 text-[13px]',
  sm: 'h-6 px-2 text-[11px]',
};

export const segmentedControlItemLayoutClassName =
  "gap-1.5 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0";

export const segmentedControlIndicatorSurfaceClassName =
  'rounded-md bg-background shadow-xs dark:bg-input';

const SegmentedControlContext = React.createContext<SegmentedControlSize>('default');

export function SegmentedControl({
  className,
  children,
  render,
  size = 'default',
  ...props
}: useRender.ComponentProps<'div'> & {
  size?: SegmentedControlSize;
}): React.ReactElement {
  const defaultProps = {
    children: (
      <>
        {children}
        <SegmentedControlIndicator />
      </>
    ),
    className: cn(
      'relative z-0 flex w-fit items-center justify-center gap-0.5 rounded-lg bg-muted p-0.5',
      className,
    ),
    'data-size': size,
    'data-slot': 'segmented-control',
  };

  const element = useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });

  return (
    <SegmentedControlContext.Provider value={size}>
      {element}
    </SegmentedControlContext.Provider>
  );
}

export function SegmentedControlItem({
  className,
  render,
  size,
  ...props
}: useRender.ComponentProps<'button'> & {
  size?: SegmentedControlSize;
}): React.ReactElement {
  const contextSize = React.useContext(SegmentedControlContext);
  const resolvedSize = size ?? contextSize;

  const defaultProps = {
    className: cn(
      'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-md border border-transparent font-medium text-muted-foreground outline-2 outline-transparent transition-[color,outline-color] duration-[var(--dur-1)] motion-reduce:transition-none hover:text-foreground focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-55 data-disabled:pointer-events-none data-disabled:opacity-55',
      'data-checked:bg-background data-checked:text-foreground data-checked:shadow-xs dark:data-checked:bg-input',
      'aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-xs dark:aria-[current=page]:bg-input',
      'data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs dark:data-pressed:bg-input',
      'aria-[pressed=true]:bg-background aria-[pressed=true]:text-foreground aria-[pressed=true]:shadow-xs dark:aria-[pressed=true]:bg-input',
      '[:has(>[data-slot=segmented-control-indicator]:not([hidden]))>&]:bg-transparent! [:has(>[data-slot=segmented-control-indicator]:not([hidden]))>&]:shadow-none!',
      segmentedControlItemLayoutClassName,
      segmentedControlItemSizeClassNames[resolvedSize],
      className,
    ),
    'data-size': resolvedSize,
    'data-slot': 'segmented-control-item',
    ...(render ? {} : { type: 'button' as const }),
  };

  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, props),
    render,
  });
}

const activeItemSelector =
  ':scope > [data-checked], :scope > [aria-current="page"], :scope > [data-pressed], :scope > [aria-pressed="true"]';

const observedAttributes = ['data-checked', 'aria-current', 'data-pressed', 'aria-pressed'];

interface ActiveItemRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

function isSameRect(a: ActiveItemRect | null, b: ActiveItemRect | null): boolean {
  return (
    a?.left === b?.left &&
    a?.top === b?.top &&
    a?.width === b?.width &&
    a?.height === b?.height
  );
}

function SegmentedControlIndicator(): React.ReactElement {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [rect, setRect] = React.useState<ActiveItemRect | null>(null);

  React.useLayoutEffect(() => {
    const root = ref.current?.parentElement;
    if (!root || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      const item = root.querySelector<HTMLElement>(activeItemSelector);
      const next: ActiveItemRect | null = item
        ? {
            height: item.offsetHeight,
            left: item.offsetLeft,
            top: item.offsetTop,
            width: item.offsetWidth,
          }
        : null;
      setRect((prev) => (isSameRect(prev, next) ? prev : next));
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList')) observeItems();
      update();
    });

    const observeItems = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      for (const child of Array.from(root.children)) {
        resizeObserver.observe(child);
        mutationObserver.observe(child, {
          attributeFilter: observedAttributes,
          attributes: true,
        });
      }
    };

    mutationObserver.observe(root, { childList: true });
    observeItems();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute top-0 left-0 -z-1 h-(--active-item-height) w-(--active-item-width) translate-x-(--active-item-left) translate-y-(--active-item-top) transition-[width,height,translate] duration-200 ease-in-out motion-reduce:transition-none',
        segmentedControlIndicatorSurfaceClassName,
      )}
      data-slot="segmented-control-indicator"
      hidden={!rect}
      ref={ref}
      style={
        {
          '--active-item-height': `${rect?.height ?? 0}px`,
          '--active-item-left': `${rect?.left ?? 0}px`,
          '--active-item-top': `${rect?.top ?? 0}px`,
          '--active-item-width': `${rect?.width ?? 0}px`,
        } as React.CSSProperties
      }
    />
  );
}
