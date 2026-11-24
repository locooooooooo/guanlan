import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from './ui/primitives';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/**
 * 顶层渲染错误边界：避免单次异常响应或空字段导致整页白屏，
 * 提供明确的错误信息与手动重试/刷新恢复入口。
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message =
      error instanceof Error && error.message
        ? error.message
        : '界面渲染发生意外错误';
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown) {
    if (typeof console !== 'undefined') {
      console.error('[guanlan] UI ErrorBoundary caught error:', error);
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="glass-page h-screen w-screen flex items-center justify-center p-6 text-[color:var(--ink-strong)]"
      >
        <div className="depth-2-card w-full max-w-md p-6 space-y-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-ctl)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_12%,transparent)] text-[color:var(--stage-ink-exec-text)]">
              <AlertTriangle className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <h1 className="text-[length:var(--text-item-title)] font-semibold text-[color:var(--ink-strong)]">
                界面暂时无法显示
              </h1>
              <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] break-words">
                {this.state.message}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={this.handleReset}>
              重试渲染
            </Button>
            <Button variant="secondary" size="sm" onClick={this.handleReload}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              重新加载页面
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
