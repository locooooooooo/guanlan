
declare const __GUANLAN_APP_VERSION__: string | undefined;
declare const __GUANLAN_GIT_SHA__: string | undefined;
declare const __GUANLAN_BUILD_TIME__: string | undefined;

export interface AppBuildInfo {
  version: string;
  gitSha: string;
  buildTime: string;
  versionTag: string;
}

const resolvedVersion =
  typeof __GUANLAN_APP_VERSION__ === 'string' && __GUANLAN_APP_VERSION__.trim()
    ? __GUANLAN_APP_VERSION__.trim()
    : '1.2.3';

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
