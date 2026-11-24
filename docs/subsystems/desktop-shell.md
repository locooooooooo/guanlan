# 桌面壳

桌面壳是一个 Tauri v2 程序 `guanlan-desktop.exe`。它**不复制**任何数据库与索引代码：壳只负责启动、切换、连接同一个 `guanlan-service`，再给网页提供十几个原生能力。安装包里另带一个 `guanlan.exe` 作为命令行与 MCP 代理的 sidecar。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 启动与窗口 | `main` 解析命令行、注册全局热键、装配 Tauri 命令、创建主窗口。 | [`guanlan-desktop/src/main.rs`](../../native/crates/guanlan-desktop/src/main.rs) |
| 工作区运行时 | `DesktopRuntime::switch_to` 校验目录、复用或重启内嵌服务、处理 `ROOT_IN_USE`。 | [`guanlan-desktop/src/main.rs`](../../native/crates/guanlan-desktop/src/main.rs) |
| 配置 | `desktop.json`：最近工作区列表与呼出热键。 | [`guanlan-desktop/src/config.rs`](../../native/crates/guanlan-desktop/src/config.rs) |
| 注入桥 | `build_init_script` 在页面脚本之前注入 `window.__GUANLAN_API__`、`window.__GUANLAN_BOOT__` 与 `SAVE_BRIDGE_JS`。 | [`guanlan-desktop/src/main.rs`](../../native/crates/guanlan-desktop/src/main.rs) |
| 原生系统操作 | 资源管理器定位、默认程序打开、剪贴板、外部文件导入。 | [`guanlan-desktop/src/system_bridge.rs`](../../native/crates/guanlan-desktop/src/system_bridge.rs) |
| 原生对话框 | Windows 上直接调 COM `IFileOpenDialog` 选文件夹与文件。 | [`guanlan-desktop/src/folder_picker.rs`](../../native/crates/guanlan-desktop/src/folder_picker.rs) |
| 右键菜单 | 安装后注册「用观澜打开此文件夹」；运行时可由设置开关。 | [`guanlan-desktop/installer/windows-context-menu.nsh`](../../native/crates/guanlan-desktop/installer/windows-context-menu.nsh)、[`guanlan-desktop/src/main.rs`](../../native/crates/guanlan-desktop/src/main.rs) |
| 应用配置 | 窗口、图标、安装包目标、WebView2 引导方式。 | [`guanlan-desktop/tauri.conf.json`](../../native/crates/guanlan-desktop/tauri.conf.json) |
| 发布配置 | 只多加一项：把 `binaries/guanlan` 作为 sidecar 打进安装包。 | [`guanlan-desktop/tauri.release.conf.json`](../../native/crates/guanlan-desktop/tauri.release.conf.json) |

## 运行路径

### 启动

1. 命令行带 `--register-context-menu` 或 `--unregister-context-menu` 时只做这一件事就退出。
2. `default_config_path` 定位 `desktop.json`：`GUANLAN_DESKTOP_CONFIG` 显式指定，否则 `%LOCALAPPDATA%\Guanlan\desktop.json`。
3. 解析启动工作区，优先级是：命令行目录（`--open`、`--workspace`、`--root` 或位置参数）> `GUANLAN_WORKSPACE_ROOT` > `desktop.json` 里仍然存在的 `lastRoot`。都没有就是**零配置首启**，由前端渲染引导，没有任何硬编码的默认目录。
4. 注册全局热键，默认 `alt+k`（`DEFAULT_HOTKEY`），`desktop.json` 的 `hotkey` 可覆盖。配置非法时回退默认并告警；注册失败只告警，不阻断启动。
5. `switch_to` 接入启动工作区，把结果作为初始状态。
6. 创建主窗口 `main`，1440×900，最小 960×600，把初始化脚本注入页面。

### 切换工作区

`switch_to` 的顺序是固定的：

1. 目录不存在返回 `NOT_FOUND`。
2. 目标与当前是同一个 `rootKey` 时直接复用现役服务，不重启。
3. 否则先 `shutdown` 旧服务，释放端口、写线程、监听与排他锁。
4. `start_service_with_projects_file` 启动新服务：端口为 0（随机）、`cors_desktop: true`、`background_index: true`，项目表文件放在 `desktop.json` 旁边。
5. 成功则把该工作区置顶写进最近列表（至多 10 条）。
6. 新工作区遇 `ROOT_IN_USE` 时不报错，而是返回 `root_in_use` 状态，附带数据目录、锁文件路径与锁诊断（pid、取锁时间），以及 `previousRoot`，让前端给出恢复选项。

退出时 `RunEvent::Exit` 里 `shutdown_active`。

### 网页如何调用原生能力

前端**不依赖** `@tauri-apps/api`，`package.json` 里只有 `@tauri-apps/cli`。壳通过初始化脚本在 `window` 上挂几个对象，前端用 [`desktopBridge.ts`](../../src/services/desktopBridge.ts) 包了一层；在浏览器里这些函数都会优雅降级。

| 注入的全局 | 用途 |
| --- | --- |
| `window.__GUANLAN_API__` | API 基址，前端据此把请求发到内嵌服务的随机端口 |
| `window.__GUANLAN_BOOT__` | 初始的 `DesktopSessionState` |
| `window.__GUANLAN_SAVE_FILE__` | 保存回写，转 `save_workspace_file` 命令 |
| `window.__GUANLAN_WORKSPACE_BRIDGE__` | `getState`、`pickFolder`、`switchWorkspace`、`removeRecentWorkspace` |
| `window.__GUANLAN_SYSTEM_BRIDGE__` | `pickExternalFiles`、`revealInExplorer`、`openWithDefaultApp`、`writeClipboardText`、`resolveWorkspacePath`、`importExternalFiles` |

壳还通过 `window.eval` 向页面派发两个自定义事件：`guanlan:native-drag-drop`（原生拖放）与 `guanlan:global-shortcut`（全局热键）。

### Tauri 命令

`save_workspace_file`、`get_desktop_state`、`pick_workspace_folder`、`pick_external_files`、`switch_workspace`、`remove_recent_workspace`、`reveal_in_explorer`、`open_with_default_app`、`write_clipboard_text`、`resolve_workspace_path`、`import_external_files`、`get_windows_context_menu_status`、`set_windows_context_menu`。共 13 个，全部经 `window.__TAURI_INTERNALS__.invoke` 调用。

## 约束与失败行为

- **壳不复制服务实现。** 任何索引、查询、写入逻辑的改动都在 `guanlan-service` 与 `guanlan-core` 里，壳只调用 `start_service_with_projects_file` 与 `RunningService`。
- **WebView 传来的路径不可信。** 所有带相对路径的命令都先过校验：拒绝绝对路径、`..`、盘符、冒号、控制符与 Windows 保留名，再逐段规范化并确认仍在工作区根下。
- **保存回写是乐观并发的。** 磁盘内容与阅读时的原文不一致就返回 `CONFLICT`，不落任何字节，见[工作区写入](workspace-writes.md)。
- **外部文件导入只写工作区内部**，禁止导入到隐藏的点目录，同名冲突自动改名。
- **`desktop.json` 读不到或解析失败时按空配置起步**，不阻断启动。旧格式只有 `lastRoot` 一个键，向后兼容。
- **Tauri 的能力清单是空的**（`capabilities.json` 为 `{}`）。网页没有被授予任何 Tauri ACL 权限，所有原生访问都经上面这 13 个命令。
- **`security.csp` 是 `null`**，没有配置内容安全策略。
- **右键菜单只由 NSIS 安装包注册。** MSI 安装后没有「用观澜打开此文件夹」，需要在设置里手动打开。菜单项写在 `HKCU` 下，免管理员提权，卸载时清除。
- release 构建不弹控制台窗口，debug 构建保留终端以便看 stderr。

## 验证

```sh
cd native
cargo test --locked -p guanlan-desktop
cargo test --locked -p guanlan-desktop -- save_workspace_file_tests
cargo test --locked -p guanlan-desktop -- desktop_runtime_switches desktop_import_external_files
cd .. && node scripts/build-windows-installer.mjs --check-only
```

桌面壳的测试里有两个带耗时断言：已建库工作区二次切回出首屏要小于 300 毫秒，外部文件导入后出现在时间线要小于 500 毫秒。它们在 `cargo test --workspace` 里随 Windows CI 一起跑。

打包与安装包的构建见[构建与发布](release-pipeline.md)。
