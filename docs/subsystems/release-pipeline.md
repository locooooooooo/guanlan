# 构建与发布

一个观澜版本由散落在仓库里的版本号、一份编译期注入的构建身份和一个 Windows 安装包组成。这一页讲它们各自在哪、谁在检查它们一致、从源码到安装包要经过哪些命令，以及推送一个标签之后发生什么。

## 职责与事实来源

| 部分 | 事实来源 | 谁在检查 |
| --- | --- | --- |
| 版本号 | `package.json` 的 `version` 是参照；另外 16 处见下文「版本号」 | `test/release-preflight.test.ts` 随 `npm test` 把 16 处逐一与它比对；`test/v12-release-parity.test.ts` 与 `test/f03-installer-migration.test.ts` 另有自己的断言 |
| 发版预检 | [`scripts/release-preflight.mjs`](../../scripts/release-preflight.mjs)：版本号、标签、构建产物三组检查 | `test/release-preflight.test.ts` |
| 前端构建身份 | `vite.config.ts` 的 `define`，运行时由 [`appBuildInfo.ts`](../../src/utils/appBuildInfo.ts) 读取 | V12-04、V12-06、V12-07 |
| 安装包配置 | [`tauri.conf.json`](../../native/crates/guanlan-desktop/tauri.conf.json) 与 [`tauri.release.conf.json`](../../native/crates/guanlan-desktop/tauri.release.conf.json) | `build-windows-installer.mjs --check-only`，以及 f03 测试 |
| 安装包构建 | [`scripts/build-windows-installer.mjs`](../../scripts/build-windows-installer.mjs) | 本地只自动测到 `--check-only`；真正的构建只在发布流水线里跑 |
| 发布流水线 | [`.github/workflows/release.yml`](../../.github/workflows/release.yml) | 预检、产物核对、资产计数；见下文「发布」 |
| 工具链 | [`native/rust-toolchain.toml`](../../native/rust-toolchain.toml) 锁定 1.99.1 | CI 与发布的 Rust 作业都从这份文件解析 `channel` 后显式安装 |
| CI | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | f03 测试断言其中有 `--check-only` 这一行 |
| 第三方许可索引 | [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES)，由 [`scripts/gen-third-party-notices.mjs`](../../scripts/gen-third-party-notices.mjs) 生成 | `test/third-party-notices.test.ts` 随 `npm test` 核对它与两份锁文件、与它自己的两张表是否对得上 |

## 版本号

版本号一共出现在 17 处。`package.json` 是参照，其余 16 处必须与它相同：

- 清单与锁文件：`package-lock.json`（顶层与 `packages[""]` 各一处）、`native/Cargo.toml` 的 `[workspace.package] version`、`native/Cargo.lock` 里三个 crate、`tauri.conf.json`。
- 写死的字面量：`src/utils/appBuildInfo.ts` 的兜底值、`vite.config.ts` 的两处兜底值、`test/v12-release-parity.test.ts` 里断言版本的四处、`scripts/visual-baseline.mjs` 里断言「关于观澜」版本的一处。

升一个版本的步骤：

1. 改 `package.json` 的 `version`，再把 `native/Cargo.toml` 的 `[workspace.package] version`、`native/crates/guanlan-desktop/tauri.conf.json` 的 `version`，以及上面列的字面量改成同一个值。
2. 让两份锁文件跟上。在仓库根目录执行 `npm install --package-lock-only --legacy-peer-deps`，在 `native/` 下执行 `cargo metadata --format-version 1 > /dev/null`。两条命令都只改版本字段，不动任何已解析的依赖版本，这一点在临时副本上核对过。
   - npm 那条要带 `--legacy-peer-deps`，是因为仓库现在有一个同伴依赖冲突（`esbuild ^0.25` 对 vite 8 的可选同伴依赖 `^0.27 || ^0.28`），不带它 `npm install` 会直接报 `ERESOLVE`。冲突本身要另行修掉。
3. 跑 `npm run notices` 重新生成第三方许可索引。两份锁文件里都有版本号，索引记着它们的 SHA-256，不重新生成的话 `npm test` 会红。
4. 跑 `npm run preflight`。它一次列出所有没对上的地方；`npm test` 里也有同样的检查。

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

安装包里也**没有随附许可文件**。`tauri.conf.json` 与 `tauri.release.conf.json` 没有配置 `bundle.resources`、`license` 或 `licenseFile`，所以仓库里的 `LICENSE` 与 `THIRD_PARTY_NOTICES` 都不会装到用户机器上。

## 第三方许可索引

`THIRD_PARTY_NOTICES` 是一份许可索引，不是完整的声明：不含各许可证的全文，许可一栏照抄各组件自己声明的许可表达式，组件内部以别的许可捆绑的素材只在注明处提及（现在只有 SQLite 一处）。取法与各自的局限写在生成器的头注释和文件自身里，要点：

- 前端以生产构建为准。生成器在内存里跑一遍 `vite.config.ts` 所用的构建（不写 `dist/`），取模块出现在 JS 产物里的 npm 包。另有三类不是模块图节点、却要把包列进来的：由包里的文件原样发出的资源、Tailwind 生成的样式表（`tailwindcss` 包里的 preflight 与主题变量整段进了 `dist` 的 CSS）、应用代码按名字导入但自己没有代码进产物的包（`d3` 只做转发）。不按 `package-lock.json` 的 `dev` 标记取，那个标记会把打包器和各平台的原生二进制都算进去。
- Rust 取 `cargo tree` 在 `x86_64-pc-windows-msvc` 目标上、沿普通依赖与构建依赖数出来的 crate，不含只在测试里用的开发依赖和本仓库自己的 crate。其中有一部分只在构建时参与，一并列出。
- 任何一项取不到（包不在锁文件里、没有声明许可、打包器没给出模块清单）都报错停下，不生成文件。

锁文件变了就要重新生成，见上文「版本号」第 3 步。`npm test` 守着的是「索引与当前依赖是否对得上」，不是「索引是否完整」：它核对文件末尾两份锁文件的 SHA-256 与两张表各自的 SHA-256，再把每个包与 `package-lock.json`、`native/Cargo.lock` 逐个对上。它不重新生成，所以**不改锁文件却让产物多带一个包**（例如从 `src/` 里导入一个已经是开发依赖的包）它发现不了，要靠 `node scripts/gen-third-party-notices.mjs --check` 重新生成一遍来比对。

## 发布

发布由 `release.yml` 完成，分两个作业。

**`build`（Windows）**，推送 `v*` 标签或手动触发时运行：

1. 预检。有标签时要求：标签等于 `v<版本>`，版本号 17 处一致，标签所指的提交是 `main` 的祖先。手动触发没有标签，只查版本号。预检不过，这一步就失败，不往下构建。
2. `node scripts/build-windows-installer.mjs`，和本地构建是同一个脚本。
3. 暂存四个文件到 `dist-release/` 并算出 `SHA256SUMS`：两个安装包、改名后的命令行 `guanlan-cli-<版本>-x86_64-pc-windows-msvc.exe`、校验和文件。
4. 核对暂存的产物：文件齐、不为空、没有多余的文件、校验和与内容一致。
5. 上传为 workflow artifact。

**`publish`（Ubuntu）**，只在推送标签时运行：

1. 下载 artifact，再核对一遍产物，不把残缺的东西发出去。
2. 生成更新说明：取上一个标签以来在 `main` 上的提交标题。**所以提交标题就是用户看到的更新内容**，要按[代码规范](../code-standards.md#提交)写。
3. 创建 Release，标题是「观澜 Guanlan vX.Y.Z」，带四个资产。只有最高的 `v*` 标签才标成 Latest；补发或重跑一个旧标签不会把 Latest 抢走。重跑时 Release 已经存在，就改说明并覆盖上传，不报错。
4. 数一遍资产，不是四个就让这一步失败。

**手动触发是演练。** 它跑完 `build` 作业并把产物留成 artifact，不创建 Release。打第一个标签之前，先用它把整条流水线走一遍。

### 发布判定

一次发布算数，要同时满足：

- 标签在 `main` 上，并且是 `origin/main` 的祖先。
- 标签所在的提交（或之后包含它的提交）有一次完整跑完并且全绿的 `ci`。被下一次推送取消的运行不算。
- Release 带齐四个资产，`SHA256SUMS` 与文件一致。
- 它是最高的版本，并且带着 Latest 标记。

**标签不等于 Release。** 打完标签要看 Release 真的存在、资产齐全。构建失败的标签要记下来，不能让下一个标签把它盖过去。打标签之前先看 `git tag` 里下一个空闲的版本号，两个人或两个会话同时打标签会撞车。

### 权限

工作流整体只有 `contents: read`，只有 `publish` 作业申请 `contents: write`。如果仓库设置把 `GITHUB_TOKEN` 的默认权限限制为只读，并且不允许工作流自行提升，`publish` 作业创建 Release 时会得到 403；那时要么放开这个限制，要么改用专用的令牌。

## 工具链与构建配置

- `native/rust-toolchain.toml` 锁定 1.99.1 并要求 `rustfmt`、`clippy` 两个组件。理由写在文件里：不锁定就无法保证「本地通过等于 CI 通过」。只有 `cargo` 在 `native/` 目录下执行时 rustup 才会读这个文件。
- `native/.cargo/config.toml` 设了 `jobs = 2`。这是针对一台开发机上 release 优化阶段偶发崩溃的缓解措施，它随仓库提交，在 CI 与发布的构建里同样生效。
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
- **action 只用基于 Node 24 的版本。** GitHub 在 2026-09-23 把 Node 20 从托管 runner 上移除，声明 `runs.using: node20` 的 action 从那以后无法运行。`actions/checkout`、`setup-node`、`upload-artifact` 的 `v4` 与 `download-artifact` 的 `v4` 都是 node20，现在用的是 `checkout@v7`、`setup-node@v7`、`upload-artifact@v7`、`download-artifact@v8`。再升大版本之前，先看新版本的 `action.yml`：`using` 是什么，自己用到的输入还在不在。
- **工具链以 `rust-toolchain.toml` 为准。** `dtolnay/rust-toolchain@stable` 只装最新 stable，并不读这个文件。CI 先解析出 `channel`，再显式传给 `dtolnay/rust-toolchain@master`。改工具链版本只改那一个文件。
- **每个 cargo 步骤有自己的超时**，卡住的步骤不会占满整个作业的时限。
- `smoke` 作业的注释里说明：夹具、期望结果与身份向量都在 `.gitignore` 里，从干净 checkout 用 `seed-fixture.ts` 重建。

`ci.yml` 从不构建安装包，也不上传产物；安装包在 `release.yml` 里构建。本地的统一入口是 `npm run gate`，见下文「验证」。

## 约束

- 安装包只支持 Windows x64。`GUANLAN_TARGET_TRIPLE` 可以改 sidecar 的名字，但产物文件名里的 `x64` 是写死的。
- 右键菜单只由 NSIS 安装包注册，见[桌面壳](desktop-shell.md)。
- release 构建不要为了体积或几个百分点的性能去开 LTO，除非先确认那个崩溃已经不存在。
- 产物的文件名同时写在三个地方：`build-windows-installer.mjs`（安装包）、`release.yml`（暂存时的改名）、`release-preflight.mjs` 的 `expectedAssetNames`（核对）。改名要三处一起改，`test/release-preflight.test.ts` 钉着预检那一处。

## 验证

```sh
npm run gate                                        # 对应 CI 的 frontend 与 rust-desktop 作业
npm run gate -- --full                              # 再加 smoke 作业的几步，需要能做 release 构建
npm run preflight                                   # 17 处版本号是否一致；加 --tag vX.Y.Z --require-on-main 核对标签
node scripts/gen-third-party-notices.mjs --check    # 第三方许可索引是否与重新生成的结果一致；需要 node_modules 与 cargo
node scripts/build-windows-installer.mjs --check-only
node native/crates/guanlan-desktop/gen-icon.mjs   # 只在改了图标样式时
```

[`scripts/gate.mjs`](../../scripts/gate.mjs) 是本地的统一入口，步骤与 CI 的对应关系写在它的头注释里。它的运行记录会点名 `cargo test` 里提前返回（跳过）的测试；CI 直接跑 `cargo test`，libtest 会截获这些测试打印的内容，日志里看不到。发布流水线没法在本地触发；它里面的每段 shell 都抽出来在本机演练过，做法记在引入它的提交说明里。
