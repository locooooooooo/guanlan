# 构建与发布

一个观澜版本由四处版本号、一份编译期注入的构建身份和一个 Windows 安装包组成。这一页讲它们各自在哪、谁在检查它们一致、以及从源码到安装包要经过哪些命令。

## 职责与事实来源

| 部分 | 事实来源 | 谁在检查 |
| --- | --- | --- |
| 版本号 | `package.json` 的 `version`、`native/Cargo.toml` 的 `[workspace.package] version`（三个 crate 用 `version.workspace = true` 继承）、`tauri.conf.json` 的 `version` | `test/v12-release-parity.test.ts` 的 V12-01 到 V12-03 把三处与字面量 `1.2.0` 比对；`test/f03-installer-migration.test.ts` 比对 `tauri.conf.json` 与 `package.json` |
| 前端构建身份 | `vite.config.ts` 的 `define`，运行时由 [`appBuildInfo.ts`](../../src/utils/appBuildInfo.ts) 读取 | V12-04、V12-06、V12-07 |
| 安装包配置 | [`tauri.conf.json`](../../native/crates/guanlan-desktop/tauri.conf.json) 与 [`tauri.release.conf.json`](../../native/crates/guanlan-desktop/tauri.release.conf.json) | `build-windows-installer.mjs --check-only`，以及 f03 测试 |
| 安装包构建 | [`scripts/build-windows-installer.mjs`](../../scripts/build-windows-installer.mjs) | 无自动测试，只有 `--check-only` |
| 工具链 | [`native/rust-toolchain.toml`](../../native/rust-toolchain.toml) 锁定 1.99.1 | CI 的三个 Rust 作业都从这份文件解析 `channel` 后显式安装 |
| CI | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | f03 测试断言其中有 `--check-only` 这一行 |

## 版本号

升一个版本要动的地方：

1. `package.json` 的 `version`（`package-lock.json` 由 npm 自己同步）。
2. `native/Cargo.toml` 的 `[workspace.package] version`（`Cargo.lock` 里三个 crate 的版本由 cargo 同步）。
3. `native/crates/guanlan-desktop/tauri.conf.json` 的 `version`。
4. `src/utils/appBuildInfo.ts` 与 `vite.config.ts` 里的兜底字面量——它们只在 Vite 的 `define` 缺席时生效，但测试会断言 `APP_BUILD_INFO.version`。
5. `test/v12-release-parity.test.ts` 里写死的 `'1.2.0'`，以及 `scripts/visual-baseline.mjs` 里「关于观澜」的版本断言。

**没有任何测试比对 `Cargo.lock`、`package-lock.json` 和那些兜底字面量**，升版本时只能靠人记得。

## 构建身份

生产构建时 `vite.config.ts` 注入三个常量：

- `__GUANLAN_APP_VERSION__`：读 `package.json`。
- `__GUANLAN_GIT_SHA__`：环境变量 `GUANLAN_GIT_SHA` 优先，否则 `git rev-parse --short HEAD`，失败则 `dev`。
- `__GUANLAN_BUILD_TIME__`：环境变量 `GUANLAN_BUILD_TIME` 优先，否则当前时间。

`appBuildInfo.ts` 在常量不存在时（node 测试）回退到兜底字面量，保证不抛 `ReferenceError`。这三个值显示在「设置 → 关于观澜」，用来分辨机器上装的是哪个安装包。

Rust 侧没有嵌入提交哈希。`env!("CARGO_PKG_VERSION")` 只在 MCP 代理的 `initialize` 应答里出现过一次。

要让两次构建字节相同，构建时必须同时指定 `GUANLAN_GIT_SHA` 与 `GUANLAN_BUILD_TIME`，否则时间戳每次都不一样。

## 安装包

`node scripts/build-windows-installer.mjs` 分三步：

1. `vite build` 产出 `dist/`。
2. `cargo build --release --locked -p guanlan-service --bin guanlan`，把 `guanlan.exe` 复制成 `guanlan-desktop/binaries/guanlan-<target triple>.exe`，作为 sidecar。
3. 调 Tauri CLI（仓内 `node_modules/@tauri-apps/cli`）打 NSIS 与 MSI 两个安装包。

产物在 `native/target/release/bundle/`：

- `nsis/Guanlan_<版本>_x64-setup.exe`
- `msi/Guanlan_<版本>_x64_zh-CN.msi`

`--check-only` 只做配置校验：两个配置文件与右键菜单钩子存在、`bundle.targets` 同时含 `nsis` 与 `msi`、挂了安装钩子、release 配置里有 `externalBin` 的 `binaries/guanlan`、图标齐备、钩子源码含六个关键指令。`--stage-only` 走完前两步就停。

安装包**没有代码签名**，也没有配置自动更新。`tauri.conf.json` 的 `bundle.windows.webviewInstallMode` 是 `embedBootstrapper`。图标源图由 `gen-icon.mjs` 生成，再经 `tauri icon` 产出全套尺寸。

## 工具链与构建配置

- `native/rust-toolchain.toml` 锁定 1.99.1 并要求 `rustfmt`、`clippy` 两个组件。理由写在文件里：不锁定就无法保证「本地通过等于 CI 通过」。只有 `cargo` 在 `native/` 目录下执行时 rustup 才会读这个文件。
- `native/.cargo/config.toml` 设了 `jobs = 2`。这是针对一台开发机上 release 优化阶段偶发崩溃的缓解措施，它随仓库提交，在 CI 上同样生效。
- `native/Cargo.toml` 的 release profile 是 `opt-level = 3` 加 `strip = true`，**刻意不开 LTO 与 `codegen-units = 1`**：本机 rustc 在 Tauri 依赖集的 thin-LTO 终码生成阶段确定性崩溃，复现过两次。

## CI

`ci.yml` 在推送到 `main`、提 PR 时触发，也可以手动触发，共四个作业：

| 作业 | 系统 | 做什么 |
| --- | --- | --- |
| `frontend` | Ubuntu | `npm ci`、`npm run lint`、`npm test`、`npm run build` |
| `rust-core` | Ubuntu | `cargo fmt --check`、对 core 与 service 跑 clippy 与 test |
| `rust-desktop` | Windows | 对整个 workspace 跑 clippy 与 test，再跑安装包配置的 `--check-only` |
| `smoke` | Ubuntu 与 Windows | 构建 release 版 `guanlan`，`npm run seed`，跑冒烟与对拍 |

几条约定：

- **工作流只有读权限**（`permissions: contents: read`）。需要写权限的发布流程在它自己的工作流里申请。
- **`main` 上的运行不会被取消。** 并发组按分支划分，PR 的运行可以被同一个 PR 的下一次推送取代，`main` 上的必须跑完，因为发布以一次完整的绿色运行为准。
- **工具链以 `rust-toolchain.toml` 为准。** `dtolnay/rust-toolchain@stable` 只装最新 stable，并不读这个文件。CI 先解析出 `channel`，再显式传给 `dtolnay/rust-toolchain@master`。改工具链版本只改那一个文件。
- **每个 cargo 步骤有自己的超时**，卡住的步骤不会占满整个作业的时限。
- `smoke` 作业的注释里说明：夹具、期望结果与身份向量都在 `.gitignore` 里，从干净 checkout 用 `seed-fixture.ts` 重建。

CI 上**从不构建真正的安装包**，也不上传任何产物。本地的统一入口是 `npm run gate`，见下文「验证」。

## 约束

- 版本号三处不一致时 `npm test` 会失败，但 `Cargo.lock` 与兜底字面量没有守卫。
- 安装包只支持 Windows x64。`GUANLAN_TARGET_TRIPLE` 可以改 sidecar 的名字，但产物文件名里的 `x64` 是写死的。
- 右键菜单只由 NSIS 安装包注册，见[桌面壳](desktop-shell.md)。
- release 构建不要为了体积或几个百分点的性能去开 LTO，除非先确认那个崩溃已经不存在。

## 验证

```sh
npm run gate                                        # 对应 CI 的 frontend 与 rust-desktop 作业
npm run gate -- --full                              # 再加 smoke 作业的几步，需要能做 release 构建
node scripts/build-windows-installer.mjs --check-only
node native/crates/guanlan-desktop/gen-icon.mjs   # 只在改了图标样式时
```

[`scripts/gate.mjs`](../../scripts/gate.mjs) 是本地的统一入口，步骤与 CI 的对应关系写在它的头注释里。
