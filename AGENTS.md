# 给编码智能体的说明

观澜是一款本地优先、零锁定的文件工作台：React 19 + Vite 的前端，Rust 写的读服务与索引（`native/`），Tauri v2 桌面壳。动代码之前按下面的顺序读。

## 改代码之前

1. **读与你任务相关的子系统参考**：[子系统设计参考](docs/subsystems/README.md)。里面是各子系统当前的职责、运行路径、状态与约束，并链接到源码里的具名符号；顺着链接核对你要改的实现，不要凭印象。
2. **按代码规范写、按它自查**：[代码规范](docs/code-standards.md)。「验收标准」一节列了一个改动合并前必须展示的每一项，没跑的检查要写明没跑。
3. **读教训**：[LESSONS.md](LESSONS.md)。合并进来的工作出过什么错，哪条规则本来能拦住它。文末的「待处理」是已知但还没修的问题。
4. **评审社区的 PR 之前**，读[贡献者规则](docs/contributors.md)：先查危害的清单、署名规则。

命令行、退出码、环境变量、数据目录、MCP 接入的完整清单在[参考手册](docs/reference.md)。

## 动手

- **先建分支**，不直接在 `main` 上提交。
- **提交之前跑 `npm run gate`。** 它一条命令跑完 CI 的 `frontend` 与 `rust-desktop` 两个作业的全部检查，并在 `native/` 下执行 cargo、替 Rust 步骤设好临时的 `GUANLAN_DATA_DIR`、在 cargo 不在 PATH 上时自己去 `~/.cargo/bin` 找、把提前返回的 Rust 测试点名在运行记录里。第一步失败就停。它结束时打印的运行记录可以直接贴进提交正文。动了身份公式、采集范围、对账判定或派生规则，再跑 `npm run gate -- --full`（含 release 构建、冒烟与 Node ↔ Rust 对拍）。
- **动了依赖就重新生成第三方许可索引**（`npm run notices`），与锁文件一起提交。升版本号会改到两份锁文件，也算动依赖。`npm test` 会核对索引与两份锁文件是否还对得上。生成时哪一项取不到，它会报错停下：这时去查清，不要写一个猜的许可。
- **提交说明写「领域: 用户现在看到什么」**，正文写三段：运行（跑了什么，各自的数字）、手动破坏（把修复拿掉后哪个测试变红）、未试。Release 的更新说明取的就是提交标题。领域词表见代码规范的「提交」一节。
- **一个提交只有一个目标。** 路上看到的别的问题写进 Issue 或 `LESSONS.md` 的「待处理」，不顺手修。
- **提交之后看一眼 `git show --stat HEAD`**，确认列出来的是不是只有你自己的文件。
- **测试要能在没有这个改动时失败。** 写完新测试，把修复拿掉跑一次，确认它变红。

## 实际在运行的代码：不要清理错东西

有几处看起来像遗留代码，实际承担着别的职责。

| 看起来像 | 实际是 |
| --- | --- |
| `server/` 目录、`src/services/FileScanner.ts`、`src/services/WorkspaceTransformer.ts` | 旧的 Node 管线。**不是运行时的一部分，但它是 Node ↔ Rust 写入对拍的基准，也是冒烟夹具的生成器。不能删，也不要去现代化它。** 它的价值在于冻结，Rust 侧要与它逐字一致，见[旧 Node 管线与对拍](docs/subsystems/legacy-node-pipeline.md)。 |
| `src/utils/guanlanEngine.ts` | 在线的界面代码，名字里的 engine 是历史遗留。二十多个组件与六个工具模块在导入它，里面有检索、大纲、diff、未读判定。里面还有一套调试用的 MCP 工具模拟，和真正的 `guanlan mcp` 代理不是一回事。 |
| `vite.config.ts` 里对 `server/` 的零引用 | 正常。Vite 只做 `/api` 代理，后端是 Rust 服务。 |
| Rust 侧与 TypeScript 侧各有一份的规则 | 有意为之的双份实现，共九条：状态迁移、Token 估算、阶段分类、卡点块解析、脱敏、未读、检索、DTO、身份公式。**改一侧必须改另一侧**，清单与各自的保证方式见[前端规则与跨语言镜像](docs/subsystems/frontend-rules.md)。 |
| `release.yml` 的手动触发 | 只构建并把产物留成 artifact，不创建 Release。只有推送 `v*` 标签才发版。 |

## 红线

这些是产品对用户的承诺，源码注释里以「停机红线」「铁律」标出。要改由维护者来改。

- **不写用户的业务文件。** 只有六条带护栏的写入路径例外，见[工作区写入](docs/subsystems/workspace-writes.md)。新增任何会写用户文件的路径，都要挂上同一套护栏。
- **删除只进系统回收站**，必须有人工确认，严禁对用户工作区文件调用永久删除的接口。
- **不拿当前内容冒充旧版本。** 快照不可读就明说。
- **不生成第二套历史。** 身份公式是与旧 Node 管线逐字兼容的契约，`rootKey` 恒按 win32 `path.resolve` 的规则求值。
- **MCP 代理不读工作区文件**，只按已索引的版本读；路径先过沙箱，敏感凭据路径一律拒绝。
- **读不全不等于没有。** 采集范围不完整时不判缺失；读不到、解析不了意味着未知。
- **冲突不覆盖。** 回写用户文件一律走乐观并发，冲突时存草案、不落盘。

## 环境上容易踩的坑

- **cargo 要在 `native/` 下执行**，rustup 才会读 `native/rust-toolchain.toml`。在仓库根目录跑用的是默认工具链，fmt 与 clippy 的结果会和 CI 不一样。
- **直接跑 `cargo test --workspace` 会写真实的数据目录**，和已安装的观澜用的是同一个。先设 `GUANLAN_DATA_DIR`，或者经由 `npm run gate` 跑。
- **本机的 Node 和 CI 的不一样时，用 CI 的版本再验一次。** CI 用 Node 22（npm 10），它对无效的同伴依赖零容忍，`npm ci` 会直接失败；Node 24 的 npm 11 会放行。仓库里曾有一个没人用的 `esbuild ^0.25` 钉子，就是这样在本机验过、到 CI 才失败。`npm test` 里有一项检查盯着依赖树，改了依赖后别忽略它。重新生成锁文件用 npm 11（Node 24 自带）：npm 10 会带进无关的改动。
- **`.css` 只能在 `src/App.tsx` 里导入**；`src/utils` 下的纯函数模块不导入 `.css` 或 React。否则 node 测试加载不了。
- **`npm run notices` 要先 `npm ci`，并找得到 cargo。** 它在内存里跑一遍生产构建，再调用 `cargo tree` 与 `cargo metadata`（在 `native/` 下）。不写 `dist/`，也不写数据目录。
- **演练应用内更新**用 `node scripts/build-windows-installer.mjs --updater-test-endpoint http://127.0.0.1:8788/latest.json`，它要求 `TAURI_SIGNING_PRIVATE_KEY` 指向仓库外的私钥（本机在 `%USERPROFILE%\.guanlan\updater\`）。这个开关只叠加进一次构建的临时配置，不写进仓库。私钥不要提交；公钥在 `tauri.conf.json`；生产 `endpoints` 留空，等更新源定了再填。
- **`cargo test` 的过滤条件按模块路径写**，不是文件名：`http_tests.rs` 挂在 `http::tests` 下。跑完看输出里的 `running N tests`，N 是 0 就等于没测。
- **干净 checkout 上有测试会跳过**：依赖生成夹具的 `identity_vectors_from_fixture` 会提前返回。`npm run gate` 会把它点名列在运行记录里；直接跑 `cargo test` 时看不到，因为测试框架会截获通过的测试打印的内容。被跳过的测试不算通过。Rust 测试要提前返回时用 `note_skipped`，不要自己打印。
- **当前约定以 `docs/` 为准**，注释里涉及的模块行为与约束统一对照 `docs/subsystems/` 与 `native/docs/`。
- **代码注释与提交说明以中文为主**，注释写「为什么」，密度与周围一致。

## 文档要跟着改

- 改动改变了某个子系统的职责、接口、状态、运行路径、兼容规则或失败行为，在**同一个提交**里更新 `docs/subsystems/` 里对应的那份参考。
- **升版本号**要改 16 处，清单与步骤见[构建与发布](docs/subsystems/release-pipeline.md#版本号)；`npm run preflight` 会一次列出所有没对上的地方。升完跑 `npm run notices`：两份锁文件里有版本号，锁文件变了，第三方许可索引要跟着重新生成。
- 改了发布产物的文件名，要同步 `release.yml`、`build-windows-installer.mjs` 与 `release-preflight.mjs` 三处。
- 修掉了「待处理」里的问题，从 `LESSONS.md` 里删掉那一条。
- 这轮工作里有值得记下的教训，写进 `LESSONS.md`：先写规则，再写为什么，最后写证据。
