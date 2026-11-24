# 观澜 Guanlan

**简体中文** | [English](README.en.md)

> 用时间线找到变化，用关系找到依据，用阅读器理解内容。

观澜是一款**本地优先、零锁定**的文件工作台：为任意目录建立可追溯的时间线与版本快照，用星图关系与证据锚点串起「为什么变成现在这样」，并内置全格式阅读器与 MCP 智能体上下文基座。

所有索引、快照与阅读状态都保存在本机私有数据目录。观澜不会自行写入或移动你的业务文件，也不依赖云端服务；少数由你显式触发的操作除外，见下文「数据与隐私」。

## 特性

- **时间线 / 日历 / 星图 / Atlas 多视图**：按发生时间、活跃密度、关系网络浏览同一份工作区。
- **版本时光机**：去重快照 + SHA-256 内容哈希，支持版本链、差异对比与「续读保持旧版」。
- **全格式阅读器**：Markdown、Office（DOCX/XLSX/PPTX）、PDF、SVG、图片、纯文本/代码，以及**无同源权限的 HTML 隔离沙盒**（离线 CSP，可按需放行 HTTPS 外链）。
- **已读 / 未读与阅读岛**：目录树递归未读汇总、单篇/目录一键标已读或未读、读后有更新双环提示，收藏与批注永不丢失。
- **决定与证据锚定**：把决定、证据指针、版本与文档章节绑定，形成可复核的因果链。
- **MCP 安全上下文**：通过 stdio 向支持 MCP 的智能体暴露受限的本地上下文工具，不提供任意路径下载。
- **桌面端**：Tauri v2 单包（内嵌 Rust 服务 + CLI sidecar），支持 Windows MSI / NSIS 安装包。

## 技术栈

| 层 | 技术 | 职责 |
| --- | --- | --- |
| Web 前端 | React 19 · Vite 8 · Tailwind CSS 4 · d3 | 时间线、星图、阅读器、Atlas 与全部交互 |
| 领域核心 | Rust · `guanlan-core` | 领域规则、SQLite 索引、去重存储、只读查询契约 |
| 读服务 | Rust · axum · rusqlite (bundled) | `/api/v1` HTTP + SSE、`guanlan` CLI、MCP stdio |
| 桌面壳 | Tauri v2 | 进程内嵌服务、窗口与安装包 |
| 参照管线 | TypeScript · Node | 早期 Node 管线；已不再作为 Vite 插件挂载，保留作 Node ↔ Rust 写入对拍的基准与夹具生成器 |

## 目录结构

```text
AGENTS.md                    给编码智能体的说明：改代码之前读什么、哪些代码不能删
src/                        前端源码（组件 / stores / services / utils）
test/                       前端与契约回归测试（node:test + tsx）
server/                     早期 Node 管线；已不再挂载，保留作 Node ↔ Rust 写入对拍的基准与夹具生成器
public/                     静态资源
scripts/                    统一门禁、发版预检、冒烟、对拍、基准、种子数据与安装包构建
docs/                       代码规范、子系统设计参考、参考手册、贡献指南
native/
  crates/guanlan-core/      领域模型、索引与只读查询
  crates/guanlan-service/   HTTP/SSE/MCP 服务与 guanlan CLI
  crates/guanlan-desktop/   Tauri v2 桌面壳
  docs/                     存储与查询 API 契约
  testdata/                 双端共用的 token / 阶段向量（入库）；其余夹具由脚本生成，不入库
```

## 快速开始

### 环境要求

- Node.js ≥ 22.13（CI 使用 22 LTS）：`server/` 依赖内置的 `node:sqlite`，Node 20 没有这个模块
- Rust 1.99.1（由 `native/rust-toolchain.toml` 锁定）
- Windows 桌面端需要 WebView2（Windows 10/11 通常已内置）

### 1. 安装前端依赖

```bash
npm ci
```

按锁文件安装。**先不要用 `npm install`**：仓库目前有一个同伴依赖冲突（顶层的 `esbuild ^0.25` 不满足 vite 8 的要求），重新解析依赖会报 `ERESOLVE`；`npm ci` 不重新解析，不受影响。

### 2. 启动 Rust 读服务

```bash
cd native
cargo run --locked -p guanlan-service -- serve --root "<你的工作区目录>" --port 8787
```

服务只监听 `127.0.0.1`，启动后会打印 `GUANLAN_ENDPOINT=http://127.0.0.1:<port>`。索引与快照默认写入 `%LOCALAPPDATA%\Guanlan\workspaces\<rootKey>`，可用 `GUANLAN_DATA_DIR` 整体覆盖。

### 3. 启动前端

```bash
npm run dev
```

打开 <http://localhost:3000>。Vite 会把 `/api` 代理到 `GUANLAN_SERVE`（默认 `http://127.0.0.1:8787`）。

### 桌面端

```bash
node scripts/build-windows-installer.mjs            # 构建 MSI + NSIS
node scripts/build-windows-installer.mjs --check-only  # 仅校验打包配置
```

## 常用命令

```bash
npm run dev        # 前端开发服务器（3000）
npm run build      # 生产构建
npm run lint       # TypeScript 类型检查（tsc --noEmit）
npm test           # 前端回归测试
npm run gate       # 提交前跑：类型检查、前端测试、构建、安装包配置校验、cargo fmt / clippy / test
npm run preflight  # 核对版本号在仓库各处是否一致
npm run notices    # 依赖有变化或升了版本号之后，重新生成第三方许可索引
npm run seed       # 生成测试夹具
```

`npm run gate` 一条命令跑完下面两组门禁，并把 Rust 测试的数据目录指向一个临时位置。`npm run gate -- --full` 再追加 release 构建、冒烟与 Node ↔ Rust 对拍。

Rust 门禁：

```bash
cd native
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

直接跑 `cargo test` 之前把 `GUANLAN_DATA_DIR` 指到一个临时目录，否则测试会写进已安装的观澜正在用的数据目录。

端到端冒烟与基准。`.ts` 脚本经 tsx 运行，都需要先构建 release 版 `guanlan`（在 `native/` 下执行 `cargo build --release --locked -p guanlan-service`）：

```bash
npm run seed                                             # 生成冒烟与对拍用的夹具（不入库）
npx tsx scripts/smoke-v1.ts --exe native/target/release/guanlan.exe
npx tsx scripts/parity-reconcile.ts --exe native/target/release/guanlan.exe   # Node ↔ Rust 写入对拍
npx tsx scripts/bench-f04-golden-tasks.ts                # 自带千级夹具
npx tsx scripts/seed-bench-volume.ts native/testdata/bench/workspace   # 下面两个基准共用的万级夹具
npx tsx scripts/bench-v1.ts --exe native/target/release/guanlan.exe
npx tsx scripts/bench-search-v1.ts --exe native/target/release/guanlan.exe
npm run build && node scripts/visual-baseline.mjs capture   # 视觉基线：需要 dist/ 与 Chrome / Edge
```

## MCP 接入

先启动 `guanlan serve`，再让智能体通过 stdio 启动：

```bash
GUANLAN_ENDPOINT=http://127.0.0.1:8787 guanlan mcp
```

MCP 只暴露白名单工具，且不提供任意路径读取；端点缺失时会明确报错而不是猜测端口。工具清单、两种接入方式与已知限制见[参考手册](docs/reference.md#mcp-接入)。

## 数据与隐私

- 业务目录**不做未经你确认的写入**：观澜不会自行写入、重命名或移动用户文件。例外是你在界面上显式触发、或智能体经授权触发的几类操作——重命名、移动、移入系统回收站、拍板回写、采纳修订草案、写入 MCP 宿主配置——它们都带有人工确认、乐观并发与路径校验，清单见[工作区写入](docs/subsystems/workspace-writes.md)。
- 删除只进系统回收站，不做永久删除。
- 索引与去重快照均在本机数据目录；卸载应用不会删除工作区原始文件。
- 无遥测、无云同步；外部网络仅在你显式开启 HTML「允许 HTTPS 外链」时由沙盒页面发起。

## 契约文档

- [`native/docs/contract-storage.md`](native/docs/contract-storage.md)：存储布局、快照三档策略与完整性校验。
- [`native/docs/contract-query-api.md`](native/docs/contract-query-api.md)：`/api/v1` 查询契约、错误包络与分页语义。

## 参与开发

- [AGENTS.md](AGENTS.md)：改代码之前读什么、哪些看着像遗留的代码其实不能删、环境上容易踩的坑。写给编码智能体，人读同样有用。
- [代码规范](docs/code-standards.md)：一个改动包含什么、测试、验收标准、评审、提交与发布。
- [子系统设计参考](docs/subsystems/README.md)：十二个子系统各自的职责、运行路径、状态与约束。
- [参考手册](docs/reference.md)：命令行、退出码、环境变量、数据目录与 MCP 接入。
- [贡献指南](docs/contributors.md)：怎么提 Issue 和 PR，评审先查什么。
- [LESSONS.md](LESSONS.md)：合并进来的工作出过什么错，以及已知待处理的问题。

## 许可证

[MIT](LICENSE)。随观澜 Windows 桌面版一同分发的第三方组件及其许可，列在 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 里；它是许可索引，不含各许可证的全文，由 `npm run notices` 生成。
