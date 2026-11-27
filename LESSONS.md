<!-- reviewed-through: 7e0b5fa (2026-11-24) -->

# 合并进来的工作给出的教训

观澜的代码有很大一部分由智能体编写，再由人或智能体评审后合并。合并进来的工作会出问题：同一个 bug 修了又修，验证做得太薄，文档写了没人跑。这里留下从这些问题里学到的东西。改代码之前先读。每条教训先写规则，再写为什么，最后是证据。一条教训在 3 个不同的日子被评审发现，就并入 [docs/code-standards.md](docs/code-standards.md)。

**初始内容从哪里来。** 仓库以单个压缩提交开源（`7e0b5fa`），更早的提交历史不在仓库里。所以下面多数教训不是从逐日复盘里来的，而是**回填**的：从源码注释和回归测试里留存的记录还原出来。每条都指向仓库里现在还读得到的证据，标注了「来源」。回填的教训只代表「出过这个问题」，不代表「评审见过几次」。从这之后，新的教训来自对合并提交的复盘，会写明是哪次。

## 读不全的时候

- **读不到、读不全，就保留原状并报告，绝不当成「没有」。**
  - 采集器对读不到的目录「保留原有记录，报告问题，不判定缺失」；触到文件数或深度上限时标记范围不完整，这一轮不做缺失检测。来源：`index/collector.rs`、`index/mod.rs` 的 `reconcile_collected`。
  - 前端的后台续拉失败时，缓存只是一部分清单。阅读状态每次变化就写回本机，按这份清单剪枝会把没拉到页的文件的进度、收藏、批注「永久删除」，且没有补救机会。现在只有续拉成功且条数与服务端计数对得上才剪枝。来源：`src/stores/useWorkspaceStore.tsx` 的剪枝守卫。
  - 参考工作区离线时保留最后已知的摘要并标 `online = false`，「绝不伪造在线数据」。来源：`guanlan-service/src/mounts.rs`。
- **半成品不冒充成品。**
  - 检索索引还在建或被清空时，检索端点返回空结果加状态字段，「绝不拿半成品索引冒充结果」。来源：`query/search.rs`。
  - L4A 进度 `total = 0` 时置空，不造 100% 的假进度。来源：`src/stores/useWorkspaceStore.tsx`。
  - 状态投影在没有服务端数据时走本地回退，未决计数如实为 `null`，不拿 `0` 冒充已对账。来源：`src/utils/stateProjection.ts`。

## 缓存与派生数据要跟着事实走

- **事实变了，建立在它上面的缓存要失效。** 磁盘改动带来新版本时若不丢掉旧的详情缓存，阅读器停在旧版本，「标为已读」标错版本，未读永远清不掉。来源：`applyFileSummaries`。
- **没定下来的状态不要缓存。** 占位版本行先到时缓存了空对象，正文补齐后仍命中旧对象，预览永远缺失。只缓存可判定的终态。来源：`src/utils/filePreviewCache.ts`。
- **多套缓存各管各的，就会互相覆盖。** 正文曾分散在三套缓存里：一个入口把「已请求」永久标记，失败后不再补取；晚到的详情整链替换版本列表，丢掉已经并入的正文。现在统一由一个带字节预算的协调层管。来源：`src/utils/revisionContentStore.ts`。
- **发起新查询时先作废旧窗口。** 「此前漏 bump」：切换「仅未定时事件」时没有推进代际，旧指纹签发的在途游标续页把旧窗口的事件追加进了新窗口。来源：`toggleUndatedEvents`。
- **派生数据可以丢弃重建，但规则版本要登记。** 检索索引的规则版本与库内标记不符时自动全量重建。抽取规则版本一升就是全量重派生，必须是一次独立的变更。来源：`index/search_index.rs`、`index/writer.rs` 的 `EXTRACT_RULE_VERSION`。

## 不可信输入

- **解析器的每一步都必须前进，并且有硬上限。** PDF 词法器在三个位置各出过一次原地打转，每次都把进程内存推到数十 GB，最后以 96 GiB 分配失败崩溃：
  - 内联图像找不到 `EI` 边界时原地 `continue`；
  - CMap 流里的游离 `>` 被通用分支反复推成空 token；
  - 解释阶段的文本累计没有封顶，「直到序列化时才崩溃」。

  三次都来自真实的 CAD 或打印 PDF，每次各加一道上限和一个回归测试。来源：`index/pdf.rs` 的 `stray_gt_in_cmap_terminates_tokenization`、`inline_image_without_ei_terminates_tokenization`、`page_text_accumulation_is_hard_capped`。
- **解析崩溃不能拖垮唯一写线程。** Office 与 PDF 解析都包在 `catch_unwind` 里。来源：`index/office.rs`、`index/pdf.rs`。
- **按字节切字符串之前，先确认切在字符边界上。**
  - 非 ASCII 路径的第 8 个字节落在多字节字符中间，`path[..n]` 在启动时 panic。来源：`domain/mounts.rs` 的 `strip_extended_prefix`。
  - 按字节取哈希前两位，遇到以多字节字符开头的损坏哈希就 panic。来源：`storage/mod.rs`、`index/ident.rs`。
- **写下去的字节必须与登记的哈希一致。** 快照落盘前重读临时文件重算哈希，不符就按「本轮不稳定」丢弃，等下一轮。采纳草案时先校验、再原子改名。来源：`Writer::write_snapshot_to_disk`、`index_jobs.rs` 的 `write_workspace_file`。

## 跨实现一致性

- **两份实现的规则，先有共享向量。** Token 估算与阶段分类各有共享向量文件，两端同读。卡点块解析与密钥脱敏也是双份实现，却没有共享向量，改的时候只能靠人记得两侧同步。来源：`native/testdata/token-vectors.json`、`stage-vectors.json`。
- **身份公式连怪癖都要照抄。** 用 `chars()` 代替 `encode_utf16()` 会让含 emoji 的路径算出不同的 ID。用 `canonicalize` 求 `rootKey` 会引入 `\\?\` 前缀。`detail_json` 的键序是手工拼串保住的。`mtime` 列声明是 INTEGER，真实库里绝大多数行却是 REAL。来源：`index/ident.rs`、`domain/path_win32.rs`、`index/derive.rs`、`storage/mod.rs`。
- **同一毫秒里的两次操作要有不同的事件身份。** 连续重命名、移动、删除曾在事件身份上碰撞，事件被静默丢弃。现在用严格单调的时间戳。来源：`index/file_ops.rs` 的 `monotonic_now_iso`。
- **被跳过的对拍不算跑过。** 身份向量夹具不在 git 里，缺文件时那个测试打印 `[skip]` 就返回。来源：`domain/vectors_fixture_test.rs`。

## 并发与状态

- **运行中的任务不能再并入新工作。** `ChangedPaths` 若并入正在运行的任务，二次保存会被静默丢弃。现在只并入仍在排队的同类任务。来源：`index_jobs.rs` 的 `changed_paths_never_merges_into_already_running_job`。
- **同哈希的恢复候选只能用一次。** 两个同哈希的新文件各自认领同一个缺失文件，会算出相同的版本 ID，在事务里撞唯一约束，回滚整轮对账。命中后立刻移出候选池。来源：`reconcile_collected`。
- **状态机的幂等就是 `running` 的持久性；首次落库是静默的。** 没有既有行时的第一次写入不发迁移事件、不计变化、不推进代际。来源：`index/state_engine.rs`。
- **连接归还之前，先清掉上一个请求的取消标志。** 否则「上一请求的取消误伤复用连接的新请求」。来源：`http/query_exec.rs`、`ReadonlyStore::reset_query_state`。
- **panic 过的查询不能把连接带走。** 此前一次 panic 让读事务永不结束，后续查询被钉在旧快照上。来源：`storage/mod.rs`（RAII 读事务守卫与连接重建）。
- **测试起的常连接要显式断开。** fetch 默认 keep-alive，`server.close()` 会一直等。来源：`test/workspace-client-v1.test.ts`。
- **服务停机前先协作取消在途长任务，且绝不在异步工作线程上裸 `join` 阻塞线程。** 桌面端切换工作区时，`RunningService::shutdown` 先关了 HTTP 与 SSE，再在异步上下文里等 `IndexJobManager::shutdown` 的 `writer_thread.join()`；若旧工作区含大体积音视频文件、正跑整盘 `VerifyAll` 流式 SHA-256，写线程无法中断，导致切换卡死数十秒乃至数分钟，期间前端对已停机的旧端口持续报「连接已中断 / 扫描失败 / 无法连接观澜读服务」。现在取消标志贯通采集、64 KiB 流式哈希与事务前对账，`ProjectRuntime::shutdown` 先发取消信号再进 `spawn_blocking` 等写线程退出，前端在切换窗口内暂停旧后端 SSE 与轮询。来源：提交「desktop: 切换工作区或停机时协作中止在途扫描，消除假断连报错」。

## 写入护栏

- **会写用户文件的路径都要过同一套护栏。** 只读保护加在了文件与文件夹操作上，拍板回写、草案采纳、MCP 宿主配置三条写路径漏了。新增写路径时要对照[工作区写入](docs/subsystems/workspace-writes.md)的护栏一览补齐。来源：2026-11-24 编写子系统参考时发现，尚未修。
- **冲突不覆盖。** 拍板回写、草案采纳、桌面壳保存都用 CAS，冲突时不写文件，把本来想写的内容存成草案。写 MCP 宿主配置时，已有文件解析失败就中止，「以避免覆写人工配置」。
- **删除只进回收站。** 严禁对用户工作区文件调用任何永久删除 API。
- **两阶段导出。** 先预览拿到令牌，再确认导出；参数漂移就拒绝。来源：`application/capsule.rs`。
- **人工审阅不可跳过，失联如实标未知。** 修复动作只有两个白名单，没有任何直接完结的动作。来源：`application/review_board.rs`。
- **候选事项不自动采纳。** 编织器只产出候选与证据。来源：`domain/candidate_weaver.rs`。

## 性能是有代价的，要量

- **只比较版本身份，不重算内容。** 未读统计曾对每个基线落后的文件跑全文二维 LCS，「2200 份文件就是 2200 次」。来源：`hasUnreadChanges`。
- **分页不能每页重读全量。** 文件摘要、事件、决定、版本链各有一次「不再每页全量重读」的修复。来源：`query/` 各模块的查询计划与分页实现。
- **频繁切换的状态不要放进 React 树。** 画布主题用 `useState` 时一次切换是整棵树重渲两次，实测 2.1 秒；移出 React 状态后 723 毫秒。来源：`src/stores/useWorkspaceStore.tsx` 的 `handleCanvasThemeChange`。
- **大列表要开窗。** 日历一次渲染 4776 天、上万个元素，改成窗口化加聚合槽。来源：`test/tl-cal-02-window.test.ts`。
- **大正文走流式，内联有字节预算。** 此前整读快照再复制再序列化，单请求峰值是正文的三倍。来源：`http/response_budget.rs`。
- **读取用流式哈希，恒定内存。** 代价是变更文件读两遍，换来的是 2 GB 的视频也只占 64 KiB 的缓冲。来源：`index/collector.rs`。

## 验证

- **写了测试不等于跑了测试。** 早期合入的测试曾只写了用例却跳过执行 `npm test`/lint/build，直到后续统一门禁才发现问题。来源：日历与时间线回归测试历史。
- **测试名要和断言一致。** MCP 代理的 `tools/list` 测试原名里写着「四个」，断言的却是 6 个；另一个用例的标题曾写「耗时 < 40ms」，断言的却是小于 120。两处现已改成一致。
- **验证命令要真的跑到测试。** 编写子系统参考时，三条 `cargo test` 命令的过滤条件写成了测试文件名，而模块路径其实是另一个名字，每条都匹配到 0 个测试、退出码却是 0。逐条真跑、看「running N tests」的 N 才发现。来源：提交「docs: 十二个子系统的设计参考」。
- **改之前先跑一遍基线。** 建立这套规范时先在未改动的提交上跑全部门禁，才发现 `npm run build` 有一次偶发崩溃。没有基线就分不清是自己弄坏的还是本来就有。
- **测试不碰真实数据目录。** 不设 `GUANLAN_DATA_DIR` 时，Rust 测试会写进已安装的观澜正在用的那个目录。
- **文档里的数字会过期，链接不会。** 契约文档写着 MCP 有 4 个工具、监听是 8 秒轮询加 1500 毫秒防抖、采集上限是 5000 和 14，代码早已是 6 个、100 毫秒加 220 毫秒、20 万和 32。写文档时链接到源码里的常量，不抄数值。同理，文档里引用提交写标题，不写哈希：提交说明一旦改写，哈希就全变了，而分支被压缩合并后它们在 `main` 上根本不存在。来源：提交「docs: 说明文字与源码对齐」。
- **检查工具自己也会错，先用已知的结果校准它。** 建立这套规范的过程中，我写的一次性检查给过三次错误结论，每次都是「没问题」，回头复核才发现不对：内联在 shell 里的 `node -e` 因为转义，把能匹配的判定式说成不匹配；变异脚本没找到目标文本却照常退出，测试全绿被当成了变异没被测出来；下载文件的路径里带了斜杠，文件根本没写成，检查结果全是「不存在」。做法：检查写成脚本文件；变异工具找不到目标就报错；每个检查先对一个已知应该报错的输入跑一遍，再用它的结论。还有一次是变异脚本的辅助函数把替换函数本身写进了文件：测试红了，红的却不是想验证的那一条。变异工具每施加一种改动，都要把实际写进去的行打出来。
- **测试绿不等于测到了。** 新写的两条测试，在理应打破它们的变异下仍然是绿的。一条只喂了一组汇总，「取第一组」和「取最后一组」没有区别；另一条的变异点根本不在被测路径上。每条新测试都要用一次变异确认它会变红。来源：提交「scripts: 一条命令跑完全部门禁」的开发过程。
- **跑不起来的流水线，把里面的脚本抽出来在本地跑。** 发布工作流没法在本地触发，就把每段 `run:` 原样抽出来，用临时的本地标签和一个记录参数的 `gh` 替身演练。第一轮就抓到一个真错误：预检那一步没有 `set -e`，预检失败之后退出码被下一行盖成了 0，构建会照常进行。来源：提交「release: 推送 v* 标签即构建安装包并发版」的开发过程。
- **先确认依赖的运行时还在不在。** `main` 上的 CI 用的 `actions/checkout@v4` 这些 action 跑在 Node 20 上，而 GitHub 在 2026-09-23 把 Node 20 从托管 runner 上移除了。升级 action 之前先看它的 `action.yml`：`using` 是什么，自己用到的输入还在不在。来源：提交「ci: action 升到基于 Node 24 的主版本」。
- **本机装的 npm 和 CI 的不是同一个版本时，本机通过说明不了 CI 会过。** 仓库里曾有一个没人用的顶层 `esbuild ^0.25`，Node 24 自带的 npm 11 放行它，CI 用 Node 22 自带的 npm 10 则让 `npm ci` 直接以 `ERESOLVE` 退出。依本机结果写下「`npm ci` 不受影响」，直到照 `ci.yml` 用 Node 22 跑一遍才发现。做法：把 CI 用的 Node 版本取到独立目录里，照工作流的命令原样跑一次；依赖树另有一个不联网的测试（`npm ls --all`）守着。
- **在输出里找「跳过」的提示之前，先确认那段输出到得了你眼前。** 门禁曾在 `cargo test` 的输出里找 `[skip]`；守它的单元测试喂的是手写的输出，一直是绿的。可 libtest 会截获通过的测试打印的内容，那段输出从来到不了门禁：同一台机器上 381 个「通过」里，有 3 个测试其实提前返回了、什么都没验证，门禁一次也没提过。做法：让测试把跳过的原因写进 `GUANLAN_TEST_SKIP_LOG`，门禁读那个文件；再对着真实的一次运行，看记录里有没有点名。
- **并发写同一个文件时，整行拼好再写一次。** 跳过记录最初用 `writeln!(file, "{name}: {reason}")` 直接写，格式化宏会把一行拆成几次 `write`，两个测试同时跳过时字交错在了一起。留了一个并发测试守着它。

## 界面

- **渲染路径里不要裸读本机存储。** 浏览器禁止所有 Cookie 时，首次访问 `localStorage` 就抛异常，顶栏渲染失败等于整棵树白屏。门控 UI 缺席可以接受，白屏不能。来源：`src/utils/safeStorage.ts`。
- **事件派发结束后不要再读 `currentTarget`。** React 在派发一结束就把它置空，而 `setState` 的更新函数可能拖到渲染期才执行，读它会抛异常并白屏。来源：`src/components/DocumentTimeMachineView.tsx`。
- **直跳不是开关。** 画布里「再点同值即清空」是 toggle，首页跳转要的是锁定聚焦，不能复用同一个处理器。来源：`src/components/app/AppMainViews.tsx`。
- **「读到这里」不能顺手清掉未读。** 记录章节定位时若推进了 `last_read_revision_id`，点一下大纲就会瞬间清掉全部「上次读后有改动」的高亮。来源：`src/stores/useWorkspaceStore.tsx`。
- **脏数据不要决定默认视图。** 一条 2013 年的事件让迷你月历默认停在十三年前。默认定位取最新活跃月份。来源：`src/components/CalendarSidePanels.tsx`。
- **随机文件名会进截图。** 截图基线用临时目录的随机后缀作为工作区名，曾让同一页面跨跑差异 2.4%。来源：`scripts/visual-baseline.mjs`。
- **判断材料新鲜度的时间要在首屏可见。** 从「待拍板」点进证据原文时，文件头只有标题、版本与状态，文档日期与采集时刻只藏在折叠的「溯源」面板和版本轴弹层里，用户看不到文章时间、无法判断材料是否过期。现在文件头常驻文档时间胶囊：`source_time`（文档日期）优先，无记载时显式写「采集于」回退 `observed_at`；摘要占位行的 `source_time` 是最早版本时间，不得冒充当前版日期。来源：2026-11-25 用户报告；`src/components/reader/readerChromeSections.tsx` 的 `buildReaderDocTimeView`，`test/reader-doc-time-01.test.ts`。
- **切换聚焦不是往集合里加一项。** 多项目侧栏的 `expandedProjects` 只 `add` 不 `delete`，切一次项目就多留一棵展开的树，而且持久化到 `localStorage`，重启后两份依旧。切换聚焦项目时要收起旧聚焦项、展开新聚焦项；用户手动展开的其他项目保持，多项目同时展开仍是显式能力。来源：2026-11-25 用户报告；`useMultiProjects.handleActivateProject`、`sidebarTree.expandedProjectsAfterActivate`，`test/multiproject-switch-collapse-01.test.ts`。

## 做对了的例子

- **迁移失败。** `f03_injected_migration_failure_rolls_back_losslessly_and_backup_restores_cleanly` 人为让迁移失败，验证原库完好、备份能还原。
- **并发的人工编辑。** `e02_concurrent_human_edit_blocks_adopt_via_cas_without_losing_any_character` 让人和智能体同时改一个文件，断言一个字符都不丢。
- **身份公式。** `scripts/parity-reconcile.ts` 刻意不共享任何实现，只比对两边的库。

## 已在代码规范里的

下面这些从第一天起就写进了 [docs/code-standards.md](docs/code-standards.md)，这里不再重复：一个改动只做一件事；修复要带一个没有它就失败的测试；测试不碰网络；测试用真实输入；不完整的范围不判缺失；解析器要有硬上限；跨实现的规则先改共享向量；超限要明确拒绝；默认值不覆盖用户设置；记录要等运行结束再写；计时测试留余量。

## 待处理

建立这套规范的过程中看到、但按「一个改动一个目标」没有顺手修的问题。每一条都应该有自己的 Issue，修掉之后从这里删掉：

- **需要维护者决定的：**
  - 只读保护护栏漏了三条写路径：拍板回写、草案采纳、MCP 宿主配置端点没有调用 `require_active_writable`。
  - 桌面应用「一键配置 MCP」写入的宿主配置在应用下次启动后失效：桌面壳每次绑随机端口，配置里的命令 `guanlan` 又不在 `PATH` 上（安装包不改 `PATH`）。
  - README 说「外部网络仅在你显式开启 HTML 允许 HTTPS 外链时访问」，但 `index.html` 会从 Google Fonts 加载三款字体，构建产物里也还在。要么去掉外部字体，要么改说明。
  - 安装包里没有随附许可文件：`tauri.conf.json` 与 `tauri.release.conf.json` 没有配置 `bundle.resources`、`license` 或 `licenseFile`，仓库里的 `LICENSE` 与 `THIRD_PARTY_NOTICES` 都不会装到用户机器上。要不要随安装包带上、以什么形式带，由维护者定。安装包按 `embedBootstrapper` 内嵌了 WebView2 引导程序（微软的安装器，约 1.8 MB），它的再分发条款没有核实过。
  - GitHub 上的 `ci` 工作流已停用。它唯一一次运行（`main` 上）五个作业一个都没启动，失败注解是「recent account payments have failed or your spending limit needs to be increased」。恢复要处理账户的 Actions 额度或付款方式；恢复之前，验证以本地 `npm run gate -- --full` 为准（见[构建与发布](docs/subsystems/release-pipeline.md#ci)）。
- **测试没有真正执行的：** 下面这个在 `npm run gate` 的运行记录里会被点名。CI 的 Rust 作业直接跑 `cargo test`，而 libtest 会截获通过的测试打印的内容，日志里看不到它。
  - `identity_vectors_from_fixture` 在干净 checkout 上跳过，因为 CI 的 Rust 作业不生成夹具。
- **测试没有隔离真实环境的：** Rust 测试自身不设数据目录，直接跑 `cargo test --workspace` 会写进已安装的观澜正在用的数据目录。`npm run gate` 替 Rust 步骤设好了临时的 `GUANLAN_DATA_DIR`，所以经由门禁跑是安全的；测试代码本身还没有改。
- **行为待核实的（只读了代码，没有运行验证）：** MCP 代理的 `resolve_endpoint` 不校验回环地址；索引写线程上除了解析器之外没有 panic 兜底，一处 panic 会让线程退出，之后的任务全部失败；查询的执行超时与取消可能以 500 而不是 503 返回；`guanlan scan` 先打开可写库、后取工作区锁。
- **仓库卫生：**
  - `npm run build` 的偶发崩溃（`@tailwindcss/oxide` 4.3.4 的 `boundary.rs`）。`npm run gate` 只对它自动重试一次，根因没有查。
  - 测试在系统临时目录里留下目录，从不清理。Rust 测试的 `guanlan-core-*`、`guanlan-svc-*` 一类（六个文件、十五处），以及 Node 测试 `test/v04-events-query.test.ts`，它每次运行留下 5 个 `guanlan-evq-*`。建立这套规范时，本机 `%TEMP%` 里有 22565 个 `guanlan-*` 目录、58498 个文件、约 4.8 GB。
  - `npm run gate` 的每一步没有超时。某一步卡住时门禁会一直等着，既不失败也不提示；CI 的 cargo 步骤有超时。建立这套规范时，有一轮门禁在 `npm test` 停了十多分钟，同一个测试文件单独跑 20 次没有复现，原因没有查清。
  - 身份数字向量测试里使用了历史本机样本路径（`native/crates/guanlan-core/src/domain/mod.rs`）；改路径会改变向量的值，要连向量一起重新生成。
  - `package.json` 没有 `description`、`license`、`repository`、`engines`。
  - 安装包没有代码签名，首次运行会有系统的未知发布者提示。
  - 视觉基线 PNG（`scripts/visual-baseline/`）自开源首快照 `7e0b5fa` 之后没有重拍，其间已有 11 个提交动过前端源码。`node scripts/visual-baseline.mjs compare` 现在对全部 27 个镜头报未声明差异并以退出码 1 结束，没有改动的星图、日历、阅读器也一样，像素比对已经不能当作回归依据；同一轮运行里的 Console 门禁（0 error / 0 warning）与 SSOT 断言仍然有效。按新界面重拍之前，需要有人确认新的外观。
  - 安装包脚本直接启动 `cargo`，不像门禁脚本那样到 `~/.cargo/bin` 去找：cargo 不在 `PATH` 上时（非交互 shell 常常如此），`node scripts/build-windows-installer.mjs` 建完 `dist/` 之后以 `ENOENT` 退出。
  - 本机设了 `HTTP_PROXY` / `HTTPS_PROXY`（127.0.0.1:10808），`NO_PROXY` 里只有回环与局域网。Tauri 打包要内嵌 WebView2 引导程序，会去 `https://go.microsoft.com/fwlink/p/?LinkId=2124703` 下载（约 1.8 MB）；这个下载经代理会挂到超时并返回 0 字节，Tauri 读到不完整的文件就报 `failed to bundle project: io: unexpected end of file`，表现为 NSIS 成功而 MSI 失败。直连该地址只要 1.2 秒且完整。打包前把 `go.microsoft.com` 与 `msedge.sf.dl.delivery.mp.microsoft.com` 加进 `NO_PROXY`（大小写两份都要）即可绕过；本机已缓存的 `%LOCALAPPDATA%\tauri\MicrosoftEdgeWebview2Setup.exe` 并不能替代，Tauri 每次仍会下载。
