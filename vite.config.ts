import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 观澜 v0.4：/api 由独立 Rust 读服务（guanlan serve，native/）提供，
// Vite 只做开发代理，不再挂载 guanlanWorkspacePlugin（契约 §4 切换边界）。
// 服务地址可用环境变量 GUANLAN_SERVE 覆盖；默认对应 `guanlan serve --port 8787`。
const GUANLAN_SERVE = process.env.GUANLAN_SERVE ?? 'http://127.0.0.1:8787';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '1.2.1';
  } catch {
    return '1.2.1';
  }
}

function resolveGitSha(): string {
  if (process.env.GUANLAN_GIT_SHA && process.env.GUANLAN_GIT_SHA.trim()) {
    return process.env.GUANLAN_GIT_SHA.trim();
  }
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: CONFIG_DIR,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
  } catch {
    return 'dev';
  }
}

function resolveBuildTime(): string {
  if (process.env.GUANLAN_BUILD_TIME && process.env.GUANLAN_BUILD_TIME.trim()) {
    return process.env.GUANLAN_BUILD_TIME.trim();
  }
  return new Date().toISOString();
}

export default defineConfig(() => {
  const appVersion = resolveAppVersion();
  const gitSha = resolveGitSha();
  const buildTime = resolveBuildTime();

  return {
    plugins: [react(), tailwindcss()],
    define: {
      __GUANLAN_APP_VERSION__: JSON.stringify(appVersion),
      __GUANLAN_GIT_SHA__: JSON.stringify(gitSha),
      __GUANLAN_BUILD_TIME__: JSON.stringify(buildTime),
    },
    resolve: {
      alias: {
        '@': path.resolve(CONFIG_DIR, '.'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: GUANLAN_SERVE,
          changeOrigin: false,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
