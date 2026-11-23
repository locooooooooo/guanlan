/**
 * V12 · 应用构建与发行身份单一真相源（编译期注入 `v1.2.0` + `git-sha` + 构建时间戳）。
 *
 * - 生产构建（vite build / Tauri bundle）由 vite.config.ts `define` 静态注入三项真实字段；
 * - Node SSR / tsx 单测环境无 Vite define 替换时自动回退至安全常量，绝不抛 ReferenceError；
 * - 在「设置 → 关于观澜」清晰透出，彻底杜绝桌面端新旧安装包混淆。
 */

declare const __GUANLAN_APP_VERSION__: string | undefined;
declare const __GUANLAN_GIT_SHA__: string | undefined;
declare const __GUANLAN_BUILD_TIME__: string | undefined;

export interface AppBuildInfo {
  /** 三端一致语义化版本号（如 "1.2.0"） */
  version: string;
  /** 编译期 Git 短哈希（如 "8d8e4ab"；无 git 环境回退 "dev"） */
  gitSha: string;
  /** 编译期 ISO-8601 UTC 构建时间戳 */
  buildTime: string;
  /** 面向 UI 展示的完整版本标识（如 "v1.2.0"） */
  versionTag: string;
}

const resolvedVersion =
  typeof __GUANLAN_APP_VERSION__ === 'string' && __GUANLAN_APP_VERSION__.trim()
    ? __GUANLAN_APP_VERSION__.trim()
    : '1.2.0';

const resolvedGitSha =
  typeof __GUANLAN_GIT_SHA__ === 'string' && __GUANLAN_GIT_SHA__.trim()
    ? __GUANLAN_GIT_SHA__.trim()
    : 'local-dev';

const resolvedBuildTime =
  typeof __GUANLAN_BUILD_TIME__ === 'string' && __GUANLAN_BUILD_TIME__.trim()
    ? __GUANLAN_BUILD_TIME__.trim()
    : '2026-11-23T00:00:00.000Z';

export const APP_BUILD_INFO: Readonly<AppBuildInfo> = Object.freeze({
  version: resolvedVersion,
  gitSha: resolvedGitSha,
  buildTime: resolvedBuildTime,
  versionTag: `v${resolvedVersion}`,
});

/** 格式化「构建时间」为易读本地/UTC 短串（保留日期与时分，无冗余毫秒）。 */
export function formatBuildTimestamp(iso: string): string {
  const trimmed = (iso || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(trimmed);
  if (match) return `${match[1]} ${match[2]} UTC`;
  return trimmed || '—';
}

/** 构造单行构建指纹（用于复制/关于卡片透出）。 */
export function formatBuildFingerprint(info: Readonly<AppBuildInfo> = APP_BUILD_INFO): string {
  return `${info.versionTag} (${info.gitSha}) · ${formatBuildTimestamp(info.buildTime)}`;
}
