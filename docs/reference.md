# 参考手册

`guanlan` 命令行、桌面壳参数、退出码、环境变量、数据目录与 MCP 接入的完整清单。每条规则由哪段代码实现，见[子系统设计参考](subsystems/README.md)。

## 获取 `guanlan` 命令

`guanlan.exe` 有两个来源：

- 从源码构建：在 `native/` 下 `cargo build --release --locked -p guanlan-service`，产物是 `native/target/release/guanlan.exe`。
- 桌面安装包会把它作为 sidecar 装在 `%LOCALAPPDATA%\Guanlan\` 下，和 `guanlan-desktop.exe` 放在一起。

**安装包不把这个目录加入 PATH。** 要在终端或 MCP 宿主里直接写 `guanlan`，得自己把它加进 PATH，或者用完整路径。

## 命令行

`guanlan` 没有子命令、子命令不认识，或参数不合法时，向 stderr 打印用法并以 2 退出。**没有 `--version` 和 `--help`。**

### `guanlan serve`

```sh
guanlan serve --root <目录> [--port <0-65535>] [--watch]
```

| 参数 | 说明 |
| --- | --- |
| `--root <目录>` | 必填。工作区根目录，必须是已存在的目录。 |
| `--port <N>` | 监听端口，默认 0，由内核随机分配。服务只监听 `127.0.0.1`。 |
| `--watch` | 开启后台增量索引：启动文件监听，并在启动时入队一次整库核验。默认关闭，此时不扫描、不监听，只提供既有数据的读取与写回端点。 |

stdout **只有一行**：`GUANLAN_ENDPOINT=http://127.0.0.1:<port>`。启动器与脚本靠它拿到权威端口。其余诊断都走 stderr，形如 `guanlan serve data_dir=… instance_id=… api_version=v1`。

### `guanlan scan`

```sh
guanlan scan --root <目录> [--initiative-dir <名>]...
```

跑一轮整库对账并打印报告：扫描份数、新文件、新版本、未变、缺失、恢复、不稳定读取、事件、陈述、引用、快照、索引代与耗时。`--initiative-dir` 可以重复，把目录名登记为专项目录，本轮即生效。

扫描会取该工作区的排他锁。已有服务实例占用同一工作区时，扫描以 `ROOT_IN_USE` 失败。它也是 Node ↔ Rust 写入对拍脚本的 Rust 一侧。

### `guanlan audit`

```sh
guanlan audit --root <目录> [--json]
```

只读诊断，零写库副作用。核验两件事：关键决定账本的防篡改哈希链，以及工作区全部活跃文件的路径是否都在沙箱边界内。检出任何篡改或越界时退出码为 3。`--json` 输出结构化结果。

### `guanlan capsule inspect`

```sh
guanlan capsule inspect <胶囊目录> [--json]
```

校验一个离线资料胶囊：清单、已校验的快照数、异常项。目录里没有清单文件时按启动失败退出 1；清单在而完整性不通过时退出码为 3。

### `guanlan storage`

```sh
guanlan storage <verify|export|diag|backups> --root <目录> [--out <路径>] [--json] [--no-snapshots]
```

| 子命令 | 做什么 | `--out` 是什么 | 退出码 |
| --- | --- | --- | --- |
| `verify` | 对全部活跃快照重新计算 SHA-256，报告受损快照影响的文件、版本、决定与事件。孤儿文件只计数，不影响结果 | 不适用 | 有损坏或缺失时为 3 |
| `export` | 全量开放导出到一个开放目录，含去重快照与 JSONL、Markdown 账本 | **目录**。不给则是数据目录下的 `exports/open-export-<时间戳>/` | 0 |
| `diag` | 生成脱敏的诊断包 ZIP | **ZIP 文件的路径**，不是目录。不给则是数据目录下的 `diagnostics/guanlan-diagnostic-<时间戳>.zip` | 0 |
| `backups` | 列出迁移前的自动备份 | 不适用 | 0 |

**`--out` 在两个子命令里含义不同。** 给 `diag` 传一个已有目录会以「拒绝访问」失败。`export` 拒绝把输出目录设成工作区根。`--no-snapshots` 让 `export` 只带账本不带快照；`--json` 输出结构化结果。

### `guanlan mcp`

```sh
guanlan mcp [--endpoint <url>]
```

MCP stdio 代理，见下文[MCP 接入](#mcp-接入)。

## 桌面壳

```sh
guanlan-desktop [<目录> | --open <目录>]
guanlan-desktop --register-context-menu
guanlan-desktop --unregister-context-menu
```

`--workspace` 与 `--root` 是 `--open` 的别名。启动工作区的优先级是命令行目录、`GUANLAN_WORKSPACE_ROOT`、`desktop.json` 里仍存在的 `lastRoot`。两个右键菜单参数只做那一件事就退出，改动的是当前用户（`HKCU`）的注册表。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 启动失败。stderr 上有一行统一错误包络 JSON，`code` 字段是 `ROOT_IN_USE`、`NOT_FOUND` 这类码 |
| 2 | 用法错误 |
| 3 | 完整性校验失败：`audit`、`capsule inspect`、`storage verify` |

## 环境变量

数值型的变量填了非法值或非正数时，一律回落到默认值。

| 变量 | 谁读 | 含义 | 默认 |
| --- | --- | --- | --- |
| `GUANLAN_DATA_DIR` | 服务、旧 Node 管线、脚本 | **整体替换**数据目录的 base，连 `Guanlan\workspaces` 这一段一起换掉，不是追加。同时让项目表落在 `<GUANLAN_DATA_DIR>/projects.json`。 | `%LOCALAPPDATA%\Guanlan\workspaces` |
| `GUANLAN_ENDPOINT` | `guanlan mcp` | 代理要连接的服务端点 | 无。缺失时退出 1 |
| `GUANLAN_DIST_DIR` | `guanlan serve` | 静态前端目录，存在才挂载 | 可执行文件同级的 `dist/` |
| `GUANLAN_PROJECTS_FILE` | 服务 | 项目表文件路径；填 `none` 关闭持久化 | `<GUANLAN_DATA_DIR>/projects.json`，否则 `%LOCALAPPDATA%\Guanlan\projects.json` |
| `GUANLAN_QUERY_POOL_SIZE` | 查询执行器 | 只读连接数，也是并发执行上限 | 4 |
| `GUANLAN_QUERY_MAX_QUEUE` | 查询执行器 | 排队上限，满了立即返回 `INDEX_BUSY` | 64 |
| `GUANLAN_QUERY_WAIT_MS` | 查询执行器 | 排队等待超时 | 5000 |
| `GUANLAN_QUERY_EXEC_MS` | 查询执行器 | 单条查询的执行超时 | 30000 |
| `GUANLAN_RESPONSE_BUDGET_MIB` | 响应预算 | 内联正文的总预算 | 64 |
| `GUANLAN_RESPONSE_MAX_MIB` | 响应预算 | 单个内联响应的上限，超过提示用 `raw=1` | 8 |
| `GUANLAN_MAX_FILES` | 对账 | 采集的文件数上限。触顶按「范围不完整」处理，不判缺失 | 200000 |
| `GUANLAN_MAX_DEPTH` | 对账 | 目录深度上限，根目录算第 0 层 | 32 |
| `GUANLAN_SNAPSHOT_TEXT_MAX_MB` | 对账 | 文本型文件做全量快照的大小上限 | 10 |
| `GUANLAN_SNAPSHOT_BINARY_MAX_MB` | 对账 | 二进制型文件做全量快照的大小上限 | 50 |
| `GUANLAN_PDF_TRACE` | PDF 解析器 | 设置为任意值即开启解析追踪日志 | 关 |
| `GUANLAN_WORKSPACE_ROOT` | 桌面壳 | 启动时打开的工作区，优先级低于命令行目录 | 无 |
| `GUANLAN_DESKTOP_CONFIG` | 桌面壳 | `desktop.json` 的显式路径 | `%LOCALAPPDATA%\Guanlan\desktop.json` |
| `GUANLAN_TARGET_TRIPLE` | 安装包脚本 | sidecar 的目标三元组，决定暂存文件名 | `x86_64-pc-windows-msvc` |
| `GUANLAN_GIT_SHA` | `vite.config.ts` | 构建身份里的提交短哈希 | `git rev-parse --short HEAD`，失败则 `dev` |
| `GUANLAN_BUILD_TIME` | `vite.config.ts` | 构建身份里的时间戳 | 构建时刻 |
| `GUANLAN_SERVE` | Vite 开发服务器 | `/api` 的代理目标 | `http://127.0.0.1:8787` |
| `DISABLE_HMR` | Vite | `true` 时关闭热更新与文件监听 | 关 |

快照的两个阈值还可以按工作区设置，存在库的 `meta` 表里（`POST /api/v1/storage/policy`，文本上限 1 到 512 MiB，二进制上限 1 到 2048 MiB）。**只有显式设置了环境变量时，环境变量才覆盖工作区的设置。**

另有一些系统变量决定路径与行为：`LOCALAPPDATA`、`USERPROFILE`、`HOMEDRIVE` 与 `HOMEPATH`、`HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`。

## 数据目录

```text
%LOCALAPPDATA%\Guanlan\
  desktop.json                    桌面壳：最近工作区（至多 10 条）与呼出热键
  projects.json                   多项目表
  workspaces\<rootKey>\           每个工作区一份数据
    index.db                      SQLite 库，WAL 模式，伴随 index.db-wal 与 index.db-shm
    blobs\<哈希前两位>\<完整哈希>  按内容寻址的去重快照
    service.lock                  工作区排他锁，由内核持有
    service.lock.info             锁的诊断信息：pid 与取锁时间
    backups\                      schema 升级前的自动备份，至多 5 份
    mounts.json                   只读参考工作区的挂载表
    diagnostics\                  诊断包 ZIP
    exports\                      开放导出
```

- `rootKey` 是 `sha256(path.resolve(根目录))` 的前 16 个十六进制字符，按 Node 的 win32 `path.resolve` 规则求值，在所有平台上都一样。
- `LOCALAPPDATA` 没有设置时，用 `<用户主目录>\AppData\Local` 代替。
- 设了 `GUANLAN_DATA_DIR` 后，`workspaces` 这一段整体换成它：数据目录变成 `<GUANLAN_DATA_DIR>\<rootKey>`。
- `desktop.json` 与 `projects.json` 在非 Windows 平台走 XDG 目录（`~/.config/guanlan/`）。工作区数据的目录布局在所有平台上都是上面这种 Windows 形式，这一点来自读代码，没有在别的平台上运行验证过。
- 观澜不写、不改名、不移动工作区里的用户文件，只有[工作区写入](subsystems/workspace-writes.md)列出的六条带护栏的路径例外。

## MCP 接入

### 命令行方式

1. 以固定端口启动服务：`guanlan serve --root "<工作区目录>" --port 8787`。
2. 让 MCP 宿主用 stdio 启动代理，并把端点告诉它：

   ```json
   {
     "mcpServers": {
       "guanlan": {
         "command": "guanlan",
         "args": ["mcp"],
         "env": { "GUANLAN_ENDPOINT": "http://127.0.0.1:8787" }
       }
     }
   }
   ```

3. `command` 要能被宿主找到：把 `guanlan.exe` 所在目录加入 PATH，或者写完整路径。

### 一键写入

`POST /api/v1/mcp/host-config` 会把上面这个条目合并写进宿主配置：`zcode` 与 `claude_code` 写工作区根的 `.mcp.json`，`cursor` 写 `.cursor/mcp.json`。请求体是 `{ host, endpoint?, dry_run, confirm }`：`dry_run` 为真只返回合并结果；落盘必须带 `confirm: true`。端点只接受 `127.0.0.1` 或 `localhost`。界面里的入口在「证道阁」上下文抽屉。

**桌面应用里一键写入的配置不会一直有效。** 桌面壳每次启动都把内嵌服务绑在随机端口上，写进配置的 `GUANLAN_ENDPOINT` 在应用下次启动后就过期；配置里的 `command` 又是不带路径的 `guanlan`，而安装包不修改 PATH。命令行方式用固定端口并自己配好 PATH，不受影响。

### 工具

| 工具 | 必填参数 | 说明 |
| --- | --- | --- |
| `guanlan.read_artifact` | `path`、`uri` 或 `file_id` 之一 | 读文档正文。`file_id` 方式必须同时给 `revision_id`。文本超过 256 KiB 时截断并标注；PDF 只返回 `raw_url` |
| `guanlan.propose_revision` | `content`，以及 `file_id` 或 `path` | 把完整修订后的正文提交为独立草案分支，不碰工作树。可带 `note`、`input_context_hashes`、`receipt_summary` |
| `guanlan.resolve_decision` | `statement_id`、`decision`、`confirmer` | 拍板。会写本地 `.md` 文件 |
| `guanlan.commit_checkpoint` | `initiative_id`、`stage`、`status`、`input_context_hash` | 提交检查点。`status` 是 `SUCCESS`、`FAILED_RETRYABLE`、`SUSPENDED_HITL` 之一 |
| `guanlan.get_context_bundle` | 无 | Token 预算感知的上下文包。可选 `intent`、`focus_file_id`、`initiative_id`、`items`、`mode`、`budget_tokens` |
| `guanlan.search_workspace` | `q` | 检索全文、路径、符号与决定编号。可选 `path_prefix`、`format`、`limit`（1 到 50，默认 20） |

代理的限制与安全边界见 [MCP stdio 代理](subsystems/mcp-stdio.md)：代理自己不读工作区文件，路径先过沙箱，敏感凭据路径被拒，单次响应上限 16 MiB，提交类工具轮询约 10 秒后如实报告超时。

## HTTP 接口

- 基址是 `http://127.0.0.1:<port>/api/v1`。桌面应用里端口是随机的，由壳注入页面。
- 成功响应直接是数据对象，顶层 `ok: true`。失败响应是 `{ ok: false, code, error, detail?, index_generation? }`，码表见[查询接口](subsystems/query-api.md#错误包络)。
- 异步操作返回 202 加 `job_id`，用 `GET /api/v1/jobs/{job_id}` 轮询；状态是 `queued`、`running`、`completed`、`failed`，取消后在活跃期报 `cancelled`。
- 实时通知走 `GET /api/v1/stream`（SSE）：连接即发 `hello`（`instance_id`、`notice_seq`、`index_generation`），之后是 `workspace-change`（`index_generation`、`new_events`、`new_revisions`、`at`、`kinds`），每 15 秒一个 `ping`。
- 逐端点的字段契约在 [`contract-query-api.md`](../native/docs/contract-query-api.md)。

## 诊断

| 想知道什么 | 怎么查 |
| --- | --- |
| 服务是否在跑、数据目录在哪、schema 版本、有无任务在跑 | `curl http://127.0.0.1:<port>/api/v1/status` |
| 决定账本是否被篡改、有没有文件路径越出工作区 | `guanlan audit --root "<目录>"` |
| 快照有没有损坏或丢失 | `guanlan storage verify --root "<目录>"` |
| 升级前的备份有哪些 | `guanlan storage backups --root "<目录>"` |
| 要一份可以发给别人的诊断材料 | `guanlan storage diag --root "<目录>"`，结果在数据目录的 `diagnostics/` 下；响应里的 `redactions_applied` 是脱敏替换的次数 |
| PDF 解析出了问题 | 设 `GUANLAN_PDF_TRACE=1` 后重新扫描，看 stderr |
| 装的是哪个版本 | 「设置 → 关于观澜」里有版本、提交短哈希与构建时间 |

服务不写日志文件，运行诊断只输出到 stderr。
