import { Toast } from '@base-ui/react/toast';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { buttonVariants } from './button';

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

export type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

type SwipeDirection = 'up' | 'down' | 'left' | 'right';

type ToastData = {
  rootProps?: Omit<
    React.ComponentProps<typeof Toast.Root>,
    'children' | 'className' | 'swipeDirection' | 'toast'
  >;
  tooltipStyle?: boolean;
};

function getSwipeDirection(position: ToastPosition): SwipeDirection[] {
  const vertical: SwipeDirection = position.startsWith('top') ? 'up' : 'down';
  if (position.includes('center')) return [vertical];
  if (position.includes('left')) return ['left', vertical];
  return ['right', vertical];
}

function upsertReplayClassName(toast: {
  type?: string;
  updateKey?: number;
}): string | undefined {
  const k = toast.updateKey ?? 0;
  if (k <= 0) return undefined;
  const isEven = k % 2 === 0;
  if (toast.type === 'error') {
    return isEven
      ? 'animate-toast-error-even motion-reduce:animate-none'
      : 'animate-toast-error-odd motion-reduce:animate-none';
  }
  return isEven
    ? 'animate-toast-success-even motion-reduce:animate-none'
    : 'animate-toast-success-odd motion-reduce:animate-none';
}

function Toasts({
  position,
  portalProps,
}: {
  position: ToastPosition;
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}): React.ReactElement {
  const { toasts } = Toast.useToastManager();
  const swipeDirection = getSwipeDirection(position);

  return (
    <Toast.Portal data-slot="toast-portal" {...portalProps}>
      <Toast.Viewport
        className={cn(
          'fixed z-60 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-inset:1rem] sm:[--toast-inset:1.5rem]',
          'data-[position*=top]:top-(--toast-inset)',
          'data-[position*=bottom]:bottom-(--toast-inset)',
          'data-[position*=left]:left-(--toast-inset)',
          'data-[position*=right]:right-(--toast-inset)',
          'data-[position*=center]:left-1/2 data-[position*=center]:-translate-x-1/2',
        )}
        data-position={position}
        data-slot="toast-viewport"
      >
        {toasts.map((toast) => {
          const Icon = toast.type
            ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS]
            : null;
          const toastData = toast.data as ToastData | undefined;

          return (
            <Toast.Root
              key={toast.id}
              className={cn(
                'absolute z-[calc(9999-var(--toast-index))] w-full select-none rounded-xl border border-border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:opacity-0 data-starting-style:opacity-0 data-starting-style:translate-y-2 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
                'data-[position*=right]:right-0 data-[position*=left]:left-0 data-[position*=top]:top-0 data-[position*=bottom]:bottom-0',
                upsertReplayClassName(toast as { type?: string; updateKey?: number }),
              )}
              data-position={position}
              data-slot="toast-root"
              swipeDirection={swipeDirection}
              toast={toast}
              {...toastData?.rootProps}
            >
              <Toast.Content className="pointer-events-auto flex items-center justify-between gap-2 overflow-hidden px-3.5 py-2.5 text-xs">
                <div className="flex items-start gap-2 min-w-0">
                  {Icon && (
                    <div
                      className="mt-0.5 shrink-0 [&>svg]:size-4"
                      data-slot="toast-icon"
                    >
                      <Icon className="in-data-[type=loading]:animate-spin in-data-[type=loading]:motion-reduce:animate-none in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning" />
                    </div>
                  )}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <Toast.Title
                      className="font-medium text-foreground leading-snug"
                      data-slot="toast-title"
                    />
                    <Toast.Description
                      className="text-muted-foreground leading-relaxed"
                      data-slot="toast-description"
                    />
                  </div>
                </div>
                {toast.actionProps && (
                  <Toast.Action
                    className={buttonVariants({ size: 'xs', variant: 'outline' })}
                    data-slot="toast-action"
                  >
                    {toast.actionProps.children}
                  </Toast.Action>
                )}
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToasts({
  portalProps,
}: {
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}): React.ReactElement {
  const { toasts } = Toast.useToastManager();

  return (
    <Toast.Portal data-slot="toast-portal" {...portalProps}>
      <Toast.Viewport className="outline-none" data-slot="toast-viewport">
        {toasts.map((toast) => {
          const toastData = toast.data as ToastData | undefined;
          const tooltipStyle = toastData?.tooltipStyle ?? true;
          const positionerProps = toast.positionerProps;
          if (!positionerProps?.anchor) return null;

          return (
            <Toast.Positioner
              key={toast.id}
              className="z-60 max-w-64"
              data-slot="toast-positioner"
              sideOffset={positionerProps.sideOffset ?? 6}
              toast={toast}
            >
              <Toast.Root
                className={cn(
                  'relative text-balance border border-border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs shadow-md transition-[scale,opacity] duration-150 motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:scale-97 data-starting-style:scale-97 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
                  tooltipStyle
                    ? 'rounded-md before:rounded-[calc(var(--radius-md)-1px)]'
                    : 'rounded-xl before:rounded-[calc(var(--radius-xl)-1px)]',
                )}
                data-slot="toast-popup"
                toast={toast}
                {...toastData?.rootProps}
              >
                <Toast.Content className="pointer-events-auto px-2.5 py-1">
                  <Toast.Title className="font-medium" data-slot="toast-title" />
                </Toast.Content>
              </Toast.Root>
            </Toast.Positioner>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export const toastManager = Toast.createToastManager();
export const anchoredToastManager = Toast.createToastManager();

export interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}

export function ToastProvider({
  children,
  position = 'bottom-right',
  portalProps,
  ...props
}: ToastProviderProps): React.ReactElement {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts portalProps={portalProps} position={position} />
    </Toast.Provider>
  );
}

export interface AnchoredToastProviderProps extends Toast.Provider.Props {
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}

export function AnchoredToastProvider({
  children,
  portalProps,
  ...props
}: AnchoredToastProviderProps): React.ReactElement {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts portalProps={portalProps} />
    </Toast.Provider>
  );
}

export { Toast as ToastPrimitive };
