import React from 'react';

export interface ProjectSwitchTransitionProps {
  projectName?: string | null;
}

/**
 * 切换项目期间的过渡条。
 *
 * 顶部一条不确定态进度条告诉用户「正在切换」，整层遮罩吞掉这期间的点击，
 * 避免切到一半误触别的项目或按钮。
 */
export function ProjectSwitchTransition({ projectName }: ProjectSwitchTransitionProps) {
  return (
    <div
      data-project-switch-transition=""
      role="status"
      className="fixed inset-0 z-[55] bg-[color:var(--ink-anchor)]/4 dark:bg-black/25"
    >
      <div
        aria-hidden="true"
        className="glx-switch-track absolute inset-x-0 top-0 h-[3px] overflow-hidden"
      >
        <span className="glx-switch-progress block h-full w-1/3 rounded-full bg-[color:var(--accent-iris-deep)]" />
      </div>
      <span className="sr-only">
        {projectName ? `正在切换到「${projectName}」` : '正在切换项目'}
      </span>
    </div>
  );
}
