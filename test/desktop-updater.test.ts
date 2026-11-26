import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  isDesktopUpdateBridgeAvailable,
  subscribeUpdateProgress,
} from '../src/services/desktopBridge';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import { WorkspaceSettingsModal } from '../src/components/modals/WorkspaceSettingsModal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

async function withFakeWindow(
  run: (fake: EventTarget & { __GUANLAN_UPDATE_BRIDGE__?: unknown }) => void | Promise<void>,
) {
  const previous = (globalThis as { window?: unknown }).window;
  const fake = new EventTarget() as EventTarget & { __GUANLAN_UPDATE_BRIDGE__?: unknown };
  (globalThis as { window?: unknown }).window = fake;
  try {
    await run(fake);
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

describe('应用内更新：没有桌面桥时安全降级', () => {
  it('浏览器/CLI 下没有更新桥，检查与安装都返回 NOT_DESKTOP，订阅是空操作', async () => {
    assert.equal(isDesktopUpdateBridgeAvailable(), false);
    const checked = await checkDesktopUpdate();
    assert.equal(checked.ok, false);
    assert.equal(checked.ok ? '' : checked.code, 'NOT_DESKTOP');
    const installed = await installDesktopUpdate();
    assert.equal(installed.ok, false);
    assert.equal(installed.ok ? '' : installed.code, 'NOT_DESKTOP');
    const unsubscribe = subscribeUpdateProgress(() => {
      throw new Error('不应该收到进度');
    });
    unsubscribe();
  });
});

describe('应用内更新：有桥时的正常路径与错误拆分', () => {
  it('检查更新返回清单里的版本与说明', async () => {
    await withFakeWindow(async (fake) => {
      fake.__GUANLAN_UPDATE_BRIDGE__ = {
        check: async () => ({
          status: 'available',
          currentVersion: '1.2.0',
          version: '1.2.1',
          notes: '修好了两处问题',
          pubDate: '2026-11-24T00:00:00Z',
        }),
        install: async () => {},
      };
      assert.equal(isDesktopUpdateBridgeAvailable(), true);
      const result = await checkDesktopUpdate();
      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.data.version : '', '1.2.1');
    });
  });

  it('Rust 的错误串拆成码与说明；普通 Error 走通用解析', async () => {
    await withFakeWindow(async (fake) => {
      fake.__GUANLAN_UPDATE_BRIDGE__ = {
        check: async () => {
          throw 'UPDATE_CHECK_FAILED: 连不上更新源';
        },
        install: async () => {
          throw new Error('UPDATE_INSTALL_FAILED: 签名不一致');
        },
      };
      const checked = await checkDesktopUpdate();
      assert.deepEqual(checked, { ok: false, code: 'UPDATE_CHECK_FAILED', error: '连不上更新源' });
      const installed = await installDesktopUpdate();
      assert.deepEqual(installed, { ok: false, code: 'UPDATE_INSTALL_FAILED', error: '签名不一致' });
    });
  });

  it('进度事件按 phase / downloaded / total 透出，异常值被收敛', async () => {
    await withFakeWindow((fake) => {
      const seen: Array<{ phase: string; downloaded: number; total: number | null }> = [];
      const unsubscribe = subscribeUpdateProgress((progress) => seen.push(progress));
      fake.dispatchEvent(
        new CustomEvent('guanlan:update-progress', {
          detail: { phase: 'downloading', downloaded: 2048, total: 4096 },
        }),
      );
      fake.dispatchEvent(
        new CustomEvent('guanlan:update-progress', { detail: { phase: 'installing', downloaded: 0, total: null } }),
      );
      fake.dispatchEvent(new CustomEvent('guanlan:update-progress', { detail: { phase: 'bogus' } }));
      unsubscribe();
      assert.deepEqual(seen, [
        { phase: 'downloading', downloaded: 2048, total: 4096 },
        { phase: 'installing', downloaded: 0, total: null },
      ]);
    });
  });
});

describe('应用内更新：关于页入口与配置', () => {
  it('关于观澜里有「检查更新」，浏览器下说明仅桌面客户端支持', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceSettingsModal, {
        isOpen: true,
        onClose: () => {},
        config: EMPTY_WORKSPACE_CONFIG,
        initialTab: 'about',
      }),
    );
    assert.ok(html.includes('data-about-update'));
    assert.ok(html.includes('检查更新'));
    assert.ok(html.includes('仅桌面客户端支持'));
    assert.ok(html.includes('data-about-update-status="idle"'));
  });

  it('tauri.conf.json 有更新器公钥，生产 endpoints 留空，安装模式为 passive', () => {
    const conf = JSON.parse(
      readFileSync(resolve(repo, 'native', 'crates', 'guanlan-desktop', 'tauri.conf.json'), 'utf8'),
    );
    const updater = conf.plugins?.updater;
    assert.ok(updater, '缺少 plugins.updater');
    assert.match(updater.pubkey, /^dW50cnVzdGVk/);
    assert.deepEqual(updater.endpoints, [], '生产配置暂时不指向任何更新源');
    assert.equal(updater.windows?.installMode, 'passive');
  });

  it('桌面壳注册了插件、两个命令与注入桥', () => {
    const main = readFileSync(resolve(repo, 'native', 'crates', 'guanlan-desktop', 'src', 'main.rs'), 'utf8');
    assert.ok(main.includes('tauri_plugin_updater::Builder::new().build()'));
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(main)?.[1] ?? '';
    assert.match(handler, /check_desktop_update/, 'check_desktop_update 没有注册进 invoke_handler');
    assert.match(handler, /install_desktop_update/, 'install_desktop_update 没有注册进 invoke_handler');
    assert.ok(main.includes('window.__GUANLAN_UPDATE_BRIDGE__ = {'));
    assert.ok(main.includes("'guanlan:update-progress'"));
  });
});
