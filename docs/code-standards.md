# 代码规范

这些规则来自这个仓库里真实出过的问题。评审者逐条检查，哪条没达到就说明是哪条。怎么描述和评审一个子系统的改动，见[子系统设计参考](subsystems/README.md)。

每条规则后面注明它的性质：**本仓事故**表示仓库里留有这次事故的记录，引文取自源码注释或回归测试；**预防性规则**表示本仓还没有出过这类事故，规则是提前立的。

## 一个改动包含什么

| 规则 | 评审看什么 | 本仓的证据 |
| --- | --- | --- |
| 一个改动只做它的目标需要的事。 | 每一处行为变化都有理由。无关的重构、顺手加的功能、策略调整各开一个改动。 | **本仓事故**。`index/writer.rs` 的 `EXTRACT_RULE_VERSION` 注释：升版本会触发全量重派生，「属于独立变更，不应与『写入侧接管』混在一次提交里」。`index/decision_block.rs` 加入卡点块解析器时刻意不升这个版本。 |
| 一次修复恰好覆盖它想覆盖的情形。 | 哪些情形变了，相邻的哪些不变。不同的错误不当成同一种处理。 | 沙箱把 `PATH_ESCAPE_DENIED` 与 `SECRET_PATH_DENIED` 分开返回；迁移把 `SCHEMA_TOO_NEW` 与 `SCHEMA_INVALID` 分开。**待改进**：这两个码目前都挂在 `INTERNAL` 包络码下，只靠错误文本区分。 |
| 改动要在整条路径上成立。 | 从用户的操作跟到最终结果：调用方、改了的状态、副作用。一个函数对了不等于整个操作对了。 | **本仓事故**。`src/stores/useWorkspaceStore.tsx` 的 `applyFileSummaries`：磁盘改动带来新版本时若不失效旧详情缓存，阅读器会停在旧版本，「『标为已读』标错旧版而永远清不掉未读」。 |
| 一次修复要覆盖同类问题的每一个兄弟。 | 搜同样的模式：同形状的每个分支、每个调用方、每条写着同一条规则的消息。 | **本仓事故**。PDF 词法器在三个不同位置各出过一次「原地不前进」：内联图像找不到 `EI`、CMap 里的游离 `>`、解释阶段的文本累计。每处各修了一次、各留一个回归测试（`index/pdf.rs` 的 `stray_gt_in_cmap_terminates_tokenization` 等）。**现存例子**：只读保护护栏加在了文件操作上，拍板回写、草案采纳、MCP 宿主配置三条写路径没有，见[工作区写入](subsystems/workspace-writes.md)。 |
| 改了一处，要重算所有建立在它之上的东西。 | 改了公式、清单、阈值或异步时序后，找出每个依赖旧含义的调用方、缓存和测试，并跑一遍。 | **本仓事故**。`toggleUndatedEvents`「此前漏 bump」代际，旧指纹签发的在途游标续页会把旧窗口事件追加进新窗口。issue #29：晚到的文件详情整链替换版本列表，丢掉已并入的正文。issue #31：占位版本行先到时缓存了空对象，正文补齐后预览永远缺失。 |
| 读取、解析或校验失败意味着「未知」。 | 绝不当成「空」「没有」或「相同」。读不到就保留之前的值并报告问题。守门用的清单读不到时应当拒绝放行。 | **本仓事故**。`index/collector.rs`：目录暂时读不到时「保留原有记录，报告问题，不判定缺失」。`src/stores/useWorkspaceStore.tsx` 的剪枝守卫：按不完整清单剪枝会把未拉到页文件的进度与批注「永久删除」。挂载离线时保留最后已知摘要，「绝不伪造在线数据」。 |
| 不可信输入的解析器必须有硬上限，崩溃不能波及唯一写线程。 | 面向用户文件的解析器（PDF、Office、归档、SVG）要有每页、每流、每 token 的上限，并包在 `catch_unwind` 里。 | **本仓事故**。`index/pdf.rs`：畸形 CAD 打印 PDF 让词法器无限堆 token，「实测把进程内存推到数十 GB 后以 96 GiB 分配失败崩溃」。此后加了每页文本累计 256 KiB、单页 Form XObject 至多 256 次、单流解压 16 MiB 三道上限。 |
| 跨实现的规则先改共享向量，再改两侧实现。 | 身份公式、Token 估算、阶段分类、状态迁移、脱敏清单在两种语言里各有一份。 | **本仓事故**。`index/ident.rs`：用 `chars()` 而不是 `encode_utf16()` 会让含 emoji 的路径「算出不同的 ID」，与库里的 `statement_id`、`decision_id`、`edge_id` 分裂。`domain/path_win32.rs`：用 `canonicalize` 求 `rootKey` 会引入 `\\?\` 前缀让哈希不同。`storage/mod.rs`：列声明是 INTEGER，真实库里 2679 行却是 REAL，读取必须按浮点兼容。清单见[前端规则与跨语言镜像](subsystems/frontend-rules.md)。 |
| 超限要明确拒绝。 | 超出预算、上限、深度时返回明确的错误或标记，并告诉调用方出路。不静默截断，不拿空结果冒充成功或「无变化」。 | **本仓事故**。`src/utils/guanlanEngine.ts`（issue #18）：diff 超限「明确拒绝（DIFF_TOO_LARGE），不用空 diff 冒充成功」。`http/response_budget.rs`：超过内联上限返回 413 并提示用 `raw=1`。MCP 代理的响应体超过 16 MiB 时拒绝并提示缩小范围。 |
| 观澜的默认值不得覆盖用户显式设置的值。 | 写任何配置之前，列出所有读取它的地方，并带着「用户已设置」的值测试。 | **本仓事故**。快照阈值的环境变量「仅当显式设置时覆盖工作区配置」。快照档位「在采集时刻判定……之后不再重算」，阈值上调不改变已有版本。桌面壳的全局热键：「抢占系统常规快捷键且不可配置即停」。采集尊重用户亲手写的 `.gitignore`。 |
| 检查要覆盖改动触及的边界。 | 数字查边界，路径查每个平台与字符集，并发查竞争与陈旧状态。按风险挑检查。 | **本仓事故**。`domain/mounts.rs`：非 ASCII 路径的第 8 个字节落在多字节字符中间，`path[..n]` 在启动时 panic；`storage/mod.rs`：按字节取哈希前两位，遇到非 ASCII 开头的损坏哈希直接 panic（issue #36）。两处都改用按字符边界的取法并留了测试。 |

## 测试

| 规则 | 评审看什么 | 本仓的证据 |
| --- | --- | --- |
| 修复要带一个「没有这个修复就会失败」的测试。 | 评审者把旧代码放回去跑新测试，它必须失败，并报出具体行为。编译失败或被跳过不算。 | **本仓事故**。`calfix`、`starfix`、`listfix`、`pkgfix` 这些以修复命名的测试文件，和 issue #18 到 #31 各自的回归测试，是仓库现在的做法。 |
| 测试不碰网络。 | 外部服务用回环桩或录下来的字节。 | **预防性规则**。本仓目前的测试都用回环桩（`MockBackend`、本地 `TcpListener`、`http.createServer` 绑 `127.0.0.1:0`），没有守卫测试。 |
| 测试用真实输入。 | 夹具要像真实请求、真实序列化输出、真实磁盘文件，包括缺字段、空值与默认值。 | **本仓事故**。`token-vectors.json` 与 `stage-vectors.json` 是实测向量；`file_row_reads_real_and_integer_mtime` 来自真实库里 REAL 与 INTEGER 混存的事实；PDF 的回归测试用的是出事的 CAD 打印 PDF 的形状。 |
| 测试断言行为，不断言实现。 | 断言用户或调用方需要的东西。格式调整与内部重构不该弄坏测试。 | **本仓现状**。约三分之一的测试文件把源码当字符串读出来做子串或正则断言，因为 node:test 没有 DOM，点击与滚动的接线只能这样守。这类断言要写明它替的是哪条接线；一旦有办法做行为测试，就换成行为测试。 |
| 测试的名字要与它守的东西一致。 | 名字、断言消息、标题里写的数字，都要和断言一致。 | **本仓事故**。MCP 代理的 `tools/list` 测试原名里写着「四个」，断言的一直是 6 个工具。`v12-release-parity.test.ts` 里一个用例的标题曾写「耗时 < 40ms」，断言的却是 `dt < 120`。两处现在都已改成一致。 |
| 在 `main` 上失败的检查是现在就要修的问题。 | 「在 main 上也一样失败」不是基线，「整套跑才失败、单跑能过」也不是。修到根上，或者开一个写明原因的 Issue。 | **本仓现状**。建立这套规范时的基线跑了一次：`npm run build` 首跑在 `@tailwindcss/oxide` 的 `boundary.rs` panic，重跑三次都通过。这是一个已知的偶发失败，尚未定位。 |
| 被跳过的测试不算通过。 | 跑完看输出里有没有 `[skip]`、`ignored` 或直接返回的用例。 | **本仓事故**。`identity_vectors_from_fixture` 在没有 `identity-vectors.json` 时打印 `[skip]` 并返回，所以干净 checkout 上的 `cargo test` 从没验证过夹具身份。`domain/triage/tests.rs` 里两个对拍测试因为依赖的 JS 源文件不在仓库里，从不执行，其中一个连提示都不打印。 |
| 测试不碰真实机器。 | 测试用临时目录、临时数据目录。绝不读写用户真实的数据目录、配置或工作区。 | **本仓事故**。不设 `GUANLAN_DATA_DIR` 时 `cargo test --workspace` 会写 `%LOCALAPPDATA%\Guanlan\workspaces\`，和已安装的观澜用的是同一个目录。项目表与 `desktop.json` 已经有 `cfg(test)` 或显式临时路径的隔离，工作区数据目录还没有。`npm run gate` 会替 Rust 步骤设好临时的 `GUANLAN_DATA_DIR`；直接跑 `cargo test` 时要自己设。`scripts/seed-volume.ts` 与 `scripts/v04-reconcile-once.ts` 会直接写真实数据目录。 |
| 测试启动的东西要随测试结束。 | 起的进程、监听、服务、常连接都要在测试返回前停掉或等它结束。 | **本仓事故**。`test/workspace-client-v1.test.ts`：fetch 默认 keep-alive，「`server.close()` 会等常连接而挂起，必须显式断掉全部连接再等关闭回调」。 |
| 计时测试两边都要留余量。 | 不用负载很重的 runner 可能超过的墙钟时间做断言；复现计时失败要靠注入延迟，不靠反复重跑。 | **本仓现状**。桌面壳测试断言切回已建库工作区小于 300 毫秒、导入出现在时间线小于 500 毫秒，随 Windows CI 一起跑。同一条验证命令在本机两次运行里一次 5 秒、一次 75 秒。 |
| 记录要等运行结束再写。 | 提交说明里写已经结束的运行的结果。「推的时候还在跑」不是记录，每个红灯都要有对应的 Issue。 | **本仓事故**。`test/calfix-01-calendar-fixes.test.ts` 文件头：「未运行 npm test/lint/build（并行施工期纪律，总装后统一门禁实测裁决）」。`test/tl-cal-02-window.test.ts`：「本轮按角色约束**未执行**测试命令」。 |

## 验收标准

一个改动只有展示了下面每一项才算合格。**写明哪些跑了、各自输出了什么。没跑的检查要列为没跑，不能略去。**

1. **一个没有这个改动就会失败的测试。** 把旧代码放回去跑新测试，它必须以一个指名行为的真实失败告终。写明是哪个测试、报了什么。然后恢复改动，确认它通过。
2. **在沙箱里跑。** Rust 测试前把 `GUANLAN_DATA_DIR` 指到一个临时目录，跑完删掉。不要在有真实工作区数据的目录上跑 `scripts/seed-volume.ts` 或 `scripts/v04-reconcile-once.ts`。
3. **构建与测试套件。** 一条命令跑完：

   ```sh
   npm run gate
   ```

   它按 CI 的 `frontend` 与 `rust-desktop` 作业的顺序跑类型检查、前端单测、构建、安装包配置校验、`cargo fmt`、`cargo clippy`、`cargo test`，第一步失败就停，结束时打印一份运行记录，可以直接贴进提交正文。`npm run gate -- --full` 会再跑 release 构建、生成夹具、冒烟与对拍。它会替你做三件容易漏的事：`cargo` 一律在 `native/` 下执行（否则用不上锁定的工具链）；Rust 测试在临时的 `GUANLAN_DATA_DIR` 下跑（否则会写进已安装的观澜正在用的数据目录）；`cargo` 不在 PATH 上时自己去 `~/.cargo/bin` 找。

   想手动跑，等价命令是：

   ```sh
   npm run lint && npm test && npm run build
   node scripts/build-windows-installer.mjs --check-only
   export GUANLAN_DATA_DIR="$(node -p "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(),'guanlan-test-'))")"
   cd native
   cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --locked
   rm -rf "$GUANLAN_DATA_DIR"
   ```

   跑全量，不要只跑你改的包。仓库的守卫测试放在改动未必触及的地方：`npm test` 里有读 `tauri.conf.json`、`native/Cargo.toml`、`ci.yml` 并跑安装包脚本的用例，`http::tests::stubs_and_unknown_routes` 守着 501 桩的清单，`watcher` 的 `timing_constants_match_contract` 守着监听常量。用 `&&` 串命令，前一步失败就停。
4. **动了身份公式、采集范围、对账判定或派生规则时，跑对拍与冒烟。** 这是「不生成第二套历史」唯一的硬保证。`npm run gate -- --full` 会跑下面这些，也可以手动执行：

   ```sh
   cd native && cargo build --release --locked -p guanlan-service && cd ..
   npm run seed
   npx tsx scripts/parity-reconcile.ts --exe native/target/release/guanlan.exe
   npx tsx scripts/smoke-v1.ts --exe native/target/release/guanlan.exe
   ```

5. **能实机验证就实机验证。** 改了解析器就用真实文件试，畸形 PDF 那次事故来自真实的 CAD 打印文件。改了桌面壳就在真实应用里走一遍。改了带耗时或点击的界面行为，跑 `node scripts/visual-baseline.mjs capture` 并亲眼看图。做不到就写明做不到；没在真东西上试过的，不要在它上面继续搭，也不要告诉用户它能用。
6. **文档跟着改。** 改动改变了某份子系统参考里写明的职责、接口、状态、运行路径、兼容规则或失败行为，就在同一个 PR 里更新那份参考。

PR 由维护者拉下来、合到最新的 `main`、在结果上跑完上面的检查之后才合并。合并说明里写明在哪个提交上跑了什么。

## 评审一个改动

- **跑起来。** 拉下来，合到当前 `main`，跑验收检查。只读 diff 不算评审。
- **故意弄坏。** 把修复拿掉，或者把被守护的代码按几种方式改坏，确认新测试对每一种都能报红。
- **对照事实来源，而不是 PR 的说法。** 涉及 Node 的行为就查 Node 的源码或实测（`domain/path_win32.rs` 是对着 Node 源码逐行移植的），涉及文件格式就找一份真实文件。
- **每个平台、每种字符集都查。** Windows 路径、非 ASCII 路径、长路径前缀、大小写。
- **顺着整条路径走。** 写操作跟到唯一写线程和磁盘，读操作跟到只读连接，确认护栏在整条路径上都成立。
- **分类要窄。** 一个标记或一类错误只覆盖它描述的那种情形。
- **预览不产生副作用。** `dry_run`、预演、预览的任何形态都不写盘。
- **不推翻已有的裁定。** 注释里写着「裁定值，已登记」「停机红线」「铁律」的地方是维护者的决定，要改由维护者来改。
- **文档与源码一致。** 参考文档里每个链接都要能打开，说法要与代码相符。
- **PR 只做它的事。** 无关的测试与重构另开 PR。注释里写函数名，不写行号。

## TypeScript 与 React

- 纯函数模块不导入 `.css` 或 React。`src/utils` 下的规则模块要能在 node 测试里直接导入。
- `.css` 只在 `src/App.tsx` 里导入，因为 tsx 的测试链加载不了 `.css` 扩展名。
- 访问本机存储一律走 `src/utils/safeStorage.ts`。隐私收紧的浏览器里首次访问 `localStorage` 就会抛异常，在渲染路径里裸读会让整棵树白屏。
- 改了 Rust DTO 就同步 `src/services/apiTypes.ts`，两边靠手工保持一致。
- 改了镜像规则就两侧一起改，并先改共享向量文件。
- `npm run lint` 只是 `tsc --noEmit`。仓库没有 ESLint、Prettier 或任何格式化工具，风格靠对照周围的代码。
- 注释写「为什么」，用中文，密度与周围一致。这个仓库的设计理由几乎都在注释里。

## Rust

- `guanlan-core` 不依赖 HTTP 框架、Tauri、MCP 宿主或 React。依赖方向是 service → core，desktop → service。
- 读侧只有只读连接，没有任何写方法。所有写库都排队到唯一写线程，不在异步处理器里直接开写连接。
- 身份规则逐字兼容。不新增第三套历史。
- MCP 代理、时间格式化、诊断包 ZIP 都是手写的，没有引入新 crate，这是当时的明确取舍。要引入依赖先问维护者。
- 面向用户文件的解析代码包在 `catch_unwind` 里，并有硬上限。
- 事务用 `Writer::transaction`，它是 `BEGIN IMMEDIATE`。不要自己拼事务。

## 提交

提交说明写改动涉及的领域，然后写用户现在看到什么，用平实的行为描述：

```
index: 定向对账的文件再次保存时不再丢第二次改动
```

给出 Issue 号或报告人。正文写怎么验证的，以及哪个测试在没有这个改动时会失败。

验证记录写在**提交正文**里，之后评审时读得到；不放在聊天记录里，也不只放在 PR 里。一个没有正文的大改动事后无法评审。

一个提交只有一个目标。两份报告一起修就是两个提交，各带各的记录，这样回滚能只退回其中一个，评审也分得清哪个测试守哪个改动。路上发现的别的问题另开一个提交。

提交之后检查 `git show --stat HEAD` 列出的是不是只有你的文件。提交的树应当是 `origin/main` 加上它自己的改动；出现一个你的改动并不想碰的文件，或者一个测试文件消失了，说明工作树是旧的：停下来，变基或拣选到 `origin/main` 上，不要从旧的 checkout 里提交文件。

提交前先建分支，不直接提交到 `main`。

领域词表：`index`、`storage`、`query`、`http`、`mcp`、`desktop`、`web`、`scripts`、`ci`、`release`、`docs`、`community`（Issue 表单、PR 模板、贡献者规则）。

## 发布

发布由 `release.yml` 自动完成，流程见[构建与发布](subsystems/release-pipeline.md#发布)。要点：

- **只有推送 `vX.Y.Z` 标签才发版。** 标签必须等于 `v` 加版本号，所指的提交必须在 `main` 上，17 处版本号必须一致。流水线第一步的预检不过，就不构建。手动触发只构建并留下产物，用来在打第一个标签之前演练。
- **发之前先在本地过一遍** `npm run preflight` 与 `npm run gate -- --full`。
- **一次发布算数，要同时满足：** 标签在 `main` 上；标签所在提交的 `ci` 完整跑完并且全绿，被取消的运行不算；Release 带齐四个资产（NSIS、MSI、命令行、`SHA256SUMS`）。
- **标签不等于 Release。** 打完标签去看 Release 是否真的存在、资产是否齐全。构建失败的标签要记下来，不能让下一个标签把它盖过去。
- **打标签之前先看 `git tag` 里下一个空闲的版本号。** 两个会话同时给同一个提交打标签会撞车，低的那个反而成了 Latest。
- **提交标题就是更新说明。** Release 的说明取上一个标签以来的提交标题，所以标题要写用户看到的变化。
- 只改测试的提交不需要单独发版。
