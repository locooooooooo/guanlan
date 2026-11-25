//! guanlan-service CLI 入口：`guanlan serve` / `scan` / `audit` / `capsule` / `storage` / `mcp`。
//!
//! 启动流程在库入口 [`guanlan_service::start_readonly_service`]（lib.rs，与桌面壳
//! 进程内嵌共用同一实现）。本文件只做参数解析与终端输出约定：
//! - `guanlan serve --root <目录> [--port N]`：监听 127.0.0.1（--port 缺省时绑定
//!   随机端口），启动时向 stdout 打印一行 `GUANLAN_ENDPOINT=http://127.0.0.1:<port>`
//!   供启动器解析；运行诊断信息只走 stderr，不污染 stdout 约定。
//!   启动失败：向 stderr 输出一行统一错误包络 JSON（契约 §0.2 结构）后以非零码退出。
//!   运行信息（实例身份/数据目录/接口版本）经 stderr 与 stdout 端点行承载，不在启动阶段写 index.db。
//! - `guanlan mcp`：MCP stdio 代理（contract-query-api.md §2.2）：手写 JSON-RPC 2.0 over stdio，
//!   六个工具的调用转发到 GUANLAN_ENDPOINT/`--endpoint` 指定的服务；端点缺失 → stderr
//!   一行统一错误包络 + 退出码 1（不猜端口）。实现见 mcp/mod.rs。
//! - `guanlan scan --root <目录>`：跑一轮整库对账。用于命令行
//!   手动补扫，以及与旧 Node 管线的写入对拍脚本（两侧同一套语义）。

use guanlan_core::error::GuanlanError;
use guanlan_service::{RunningService, ServeConfig};

const USAGE: &str = "用法:\n  guanlan serve --root <目录> [--port N] [--watch]\n  guanlan scan --root <目录> [--initiative-dir <名>...]\n  guanlan audit --root <目录> [--json]\n  guanlan capsule inspect <胶囊目录> [--json]\n  guanlan storage <verify|export|diag|backups> --root <目录> [--out <路径>] [--json]\n  guanlan mcp";

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => run_serve(&args[1..]).await,
        Some("scan") => run_scan(&args[1..]),
        Some("audit") => run_audit(&args[1..]),
        Some("capsule") => run_capsule(&args[1..]),
        Some("storage") => run_storage(&args[1..]),
        Some("mcp") => guanlan_service::mcp::run(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

/// `guanlan storage <verify|export|diag> --root <目录> [--out <路径>] [--json]`
fn run_storage(args: &[String]) {
    let Some(sub) = args.first().map(String::as_str) else {
        eprintln!("storage 子命令需要 verify | export | diag\n{USAGE}");
        std::process::exit(2);
    };
    let mut root: Option<String> = None;
    let mut out: Option<String> = None;
    let mut json_output = false;
    let mut include_snapshots = true;
    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
            "--root" => {
                idx += 1;
                root = args.get(idx).cloned();
            }
            "--out" => {
                idx += 1;
                out = args.get(idx).cloned();
            }
            "--json" => json_output = true,
            "--no-snapshots" => include_snapshots = false,
            other => {
                eprintln!("未知参数: {other}\n{USAGE}");
                std::process::exit(2);
            }
        }
        idx += 1;
    }
    let Some(root) = root.filter(|s| !s.is_empty()) else {
        eprintln!("storage {sub} 需要 --root <目录>\n{USAGE}");
        std::process::exit(2);
    };
    let store = match guanlan_core::storage::ReadonlyStore::open_for_root(&root) {
        Ok(s) => s,
        Err(err) => fail_with_envelope(&err),
    };
    match sub {
        "verify" => {
            let report = match guanlan_core::storage::maintenance::verify_blobs_integrity(&store) {
                Ok(r) => r,
                Err(err) => fail_with_envelope(&err),
            };
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_owned())
                );
            } else {
                println!(
                    "观澜快照 SHA-256 完整性校验：{}\n  已检验：{} 份（完好 {} / 损坏 {} / 缺失 {} / 孤儿 {}）",
                    if report.ok { "PASS" } else { "FAIL" },
                    report.checked_blobs,
                    report.healthy_blobs,
                    report.corrupted_count,
                    report.missing_count,
                    report.orphan_blob_count,
                );
                for imp in &report.impacts {
                    eprintln!(
                        "  [{}] {} — {}",
                        imp.issue_kind, imp.content_hash, imp.detail
                    );
                }
            }
            if !report.ok {
                std::process::exit(3);
            }
        }
        "export" => {
            let resp = match guanlan_core::storage::maintenance::export_workspace_open_archive(
                &store,
                &guanlan_core::storage::maintenance::WorkspaceOpenExportRequest {
                    include_snapshots,
                    output_dir: out,
                },
            ) {
                Ok(r) => r,
                Err(err) => fail_with_envelope(&err),
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).unwrap_or_else(|_| "{}".to_owned())
            );
        }
        "diag" => {
            let resp = match guanlan_core::storage::maintenance::export_diagnostic_zip(
                &store,
                out.as_deref(),
            ) {
                Ok(r) => r,
                Err(err) => fail_with_envelope(&err),
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).unwrap_or_else(|_| "{}".to_owned())
            );
        }
        "backups" => {
            let items =
                match guanlan_core::storage::migration::list_migration_backups(store.data_dir()) {
                    Ok(list) => list,
                    Err(err) => fail_with_envelope(&err),
                };
            let payload = serde_json::json!({
                "ok": true,
                "schema_version": store.schema_version().unwrap_or(0),
                "max_retained": guanlan_core::storage::migration::MAX_MIGRATION_BACKUPS,
                "items": items,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
            );
        }
        other => {
            eprintln!("未知 storage 子命令: {other}\n{USAGE}");
            std::process::exit(2);
        }
    }
}

/// `guanlan capsule inspect <胶囊目录> [--json]` —— 校验并打印离线事项资料胶囊摘要与完整性状态
fn run_capsule(args: &[String]) {
    if args.first().map(String::as_str) != Some("inspect") {
        eprintln!("capsule 子命令当前支持: inspect <胶囊目录> [--json]\n{USAGE}");
        std::process::exit(2);
    }
    let mut dir: Option<String> = None;
    let mut json_output = false;
    for arg in &args[1..] {
        if arg == "--json" {
            json_output = true;
        } else if dir.is_none() && !arg.starts_with('-') {
            dir = Some(arg.clone());
        } else {
            eprintln!("未知参数: {arg}\n{USAGE}");
            std::process::exit(2);
        }
    }
    let Some(dir) = dir else {
        eprintln!("capsule inspect 需要 <胶囊目录>\n{USAGE}");
        std::process::exit(2);
    };
    let report =
        match guanlan_core::application::capsule::inspect_capsule_dir(std::path::Path::new(&dir)) {
            Ok(r) => r,
            Err(error) => fail_with_envelope(&error),
        };
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_owned())
        );
    } else {
        println!(
            "观澜事项资料胶囊校验：{}\n  标题：{}（{} · 模式 {}）\n  完整性：{}（已校验快照 {} 份 / 异常 {} 项）\n  内容：{} 文件 · {} 事件 · {} 决定 · {} 关联边",
            report.capsule_dir,
            report.manifest.title,
            report.manifest.schema_version,
            report.manifest.mode.as_str(),
            if report.integrity_ok {
                "PASS（完整可信）"
            } else {
                "FAIL（存在损坏或缺失）"
            },
            report.checked_snapshots,
            report.integrity_issues.len(),
            report.manifest.files.len(),
            report.manifest.events.len(),
            report.manifest.decisions.len(),
            report.manifest.relations.len(),
        );
        for issue in &report.integrity_issues {
            eprintln!("  [CAPSULE] {issue}");
        }
    }
    if !report.integrity_ok {
        std::process::exit(3);
    }
}

/// 只读安全与防篡改账本诊断命令 `guanlan audit --root <目录> [--json]`。
///
/// 零写库副作用（`ReadonlyStore::open`），同时核验：
/// 1. `decision_ledger_chain` 关键决定防篡改哈希链（内容篡改、链节点删改、绕过伪造、链尾截断）；
/// 2. 工作区全部活跃 `files.current_path` 权限沙箱边界（路径逃逸、符号链接越界）。
///
/// 检出任意篡改或越界违规时返回退出码 3；全绿返回 0。
fn run_audit(args: &[String]) {
    let mut root: Option<String> = None;
    let mut json_output = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--root" => {
                index += 1;
                root = args.get(index).cloned();
            }
            "--json" => json_output = true,
            other => {
                eprintln!("未知参数: {other}\n{USAGE}");
                std::process::exit(2);
            }
        }
        index += 1;
    }
    let Some(root) = root.filter(|value| !value.is_empty()) else {
        eprintln!("audit 需要 --root <目录>\n{USAGE}");
        std::process::exit(2);
    };

    let store = match guanlan_core::storage::ReadonlyStore::open_for_root(&root) {
        Ok(store) => store,
        Err(error) => fail_with_envelope(&error),
    };
    let workspace = match store.workspace() {
        Ok(ws) => ws,
        Err(error) => fail_with_envelope(&error),
    };
    let ledger = match guanlan_core::storage::ledger::verify_decision_ledger(&store) {
        Ok(report) => report,
        Err(error) => fail_with_envelope(&error),
    };
    let sandbox = match guanlan_core::storage::sandbox::audit_workspace_file_paths(&store) {
        Ok(report) => report,
        Err(error) => fail_with_envelope(&error),
    };
    let all_ok = ledger.ok && sandbox.ok;

    if json_output {
        let payload = serde_json::json!({
            "ok": all_ok,
            "workspace_id": workspace.workspace_id,
            "root_path": workspace.root_path,
            "index_generation": workspace.index_generation,
            "ledger": ledger,
            "sandbox": sandbox,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
        );
    } else {
        println!(
            "观澜账本与权限沙箱诊断：{}\n  状态：{}\n  账本链：{}（已验证 {} 条 / 关键事件 {} 条 / 异常 {} 项）\n  沙箱界：{}（已检查 {} 文件 / 违规 {} 项）",
            workspace.root_path,
            if all_ok { "PASS（完好无篡改）" } else { "FAIL（检测到篡改或越界异常）" },
            if ledger.ok { "完好" } else { "异常" },
            ledger.verified_entries,
            ledger.sealed_events_total,
            ledger.issues.len(),
            if sandbox.ok { "安全" } else { "越界" },
            sandbox.checked_files,
            sandbox.violations.len(),
        );
        for issue in &ledger.issues {
            eprintln!(
                "  [LEDGER:{}] seq={:?} event={:?} {}",
                issue.code, issue.chain_seq, issue.event_id, issue.detail
            );
        }
        for violation in &sandbox.violations {
            eprintln!(
                "  [SANDBOX] file_id={} path={} {}",
                violation.file_id, violation.path, violation.reason
            );
        }
    }

    if !all_ok {
        std::process::exit(3);
    }
}

/// 跑一轮整库对账：打开（或创建）持久库 → 采集 → 对账 → 写版本/事件/证据。
fn run_scan(args: &[String]) {
    let mut root: Option<String> = None;
    // 支持多次传入 --initiative-dir <名>，幂等追加到 meta.initiative_dirs
    let mut initiative_dirs: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--root" => {
                index += 1;
                root = args.get(index).cloned();
            }
            "--initiative-dir" => {
                index += 1;
                if let Some(dir) = args.get(index).cloned() {
                    initiative_dirs.push(dir);
                }
            }
            other => {
                eprintln!("未知参数: {other}\n{USAGE}");
                std::process::exit(2);
            }
        }
        index += 1;
    }
    let Some(root) = root.filter(|value| !value.is_empty()) else {
        eprintln!("scan 需要 --root <目录>\n{USAGE}");
        std::process::exit(2);
    };

    let mut writer = match guanlan_core::index::Writer::open(&root) {
        Ok(writer) => writer,
        Err(error) => fail_with_envelope(&error),
    };
    // 同工作区排他锁：手动扫描与服务实例不能同时写同一个库
    // （OS 级排他锁，进程退出由内核自动释放）
    let data_dir = match guanlan_core::storage::default_data_dir(&root) {
        Ok(dir) => dir,
        Err(error) => fail_with_envelope(&error),
    };
    let _lock = match guanlan_service::runtime::acquire_workspace_lock(&data_dir) {
        Ok(lock) => lock,
        Err(error) => fail_with_envelope(&error),
    };
    // 先登记专项目录（幂等覆盖 meta.initiative_dirs），再对账
    // ——新识别规则在本轮即生效
    if !initiative_dirs.is_empty() {
        let mut existing = writer.initiative_dirs().unwrap_or_default();
        for dir in &initiative_dirs {
            if !existing.contains(dir) {
                existing.push(dir.clone());
            }
        }
        if let Err(error) = writer.set_initiative_dirs(&existing) {
            fail_with_envelope(&error);
        }
    }
    let report = match guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::from_env(),
    ) {
        Ok(report) => report,
        Err(error) => fail_with_envelope(&error),
    };

    println!("工作区：{root}");
    println!(
        "本次对账：\n  扫描 {} 份（MD {} / SVG {} / PDF {} / 其它格式 {}）",
        report.scanned,
        report.by_format.md,
        report.by_format.svg,
        report.by_format.pdf,
        report.by_format.by_token.values().sum::<usize>()
    );
    if report.metadata_only_revisions > 0 || report.ignored_paths > 0 {
        println!(
            "  仅记元数据 {} 份 · .gitignore 排除 {} 项",
            report.metadata_only_revisions, report.ignored_paths
        );
    }
    println!(
        "  基线扫描：{}\n  新文件 {} · 新版本 {} · 内容修改 {}",
        if report.initial_baseline {
            "是"
        } else {
            "否"
        },
        report.new_files,
        report.new_revisions,
        report.content_changed
    );
    println!(
        "  未变 {} · 仅 mtime {} · 缺失 {} · 恢复 {} · 不稳定读取 {}",
        report.unchanged,
        report.mtime_only,
        report.missing,
        report.recovered,
        report.unstable_reads
    );
    println!(
        "  事件新增 {} · 跳过 {} · 决策事件 {}",
        report.events_inserted, report.events_skipped, report.decision_events_inserted
    );
    println!(
        "  陈述 {} · 引用 {} · 快照新写 {} · 派生重建 {}",
        report.statements_upserted,
        report.edges_upserted,
        report.snapshots_written,
        if report.derived_rebuilt { "是" } else { "否" }
    );
    println!(
        "  索引第 {} 代 · 耗时 {} ms",
        report.generation, report.duration_ms
    );
}

/// 启动失败：输出一行统一错误包络 JSON（契约 §0.2 结构）到 stderr 后退出。
/// 退出码 1；错误码在包络 code 字段（如 ROOT_IN_USE/NOT_FOUND）供启动器识别。
fn fail_with_envelope(err: &GuanlanError) -> ! {
    let envelope = err.to_envelope(None);
    let line = serde_json::to_string(&envelope).unwrap_or_else(|_| {
        format!(
            "{{\"ok\":false,\"code\":\"{}\",\"error\":\"启动失败\"}}",
            err.code()
        )
    });
    eprintln!("{line}");
    std::process::exit(1);
}

/// 解析并运行 `guanlan serve`（启动流程见 lib.rs）。
async fn run_serve(args: &[String]) {
    let mut root: Option<String> = None;
    let mut port: u16 = 0; // 缺省随机端口：绑定 0 由内核分配
    let mut watch = false; // 显式开启后台增量索引
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--root" => {
                i += 1;
                root = args.get(i).cloned();
            }
            "--watch" => watch = true,
            "--port" => {
                i += 1;
                match args.get(i).and_then(|v| v.parse::<u16>().ok()) {
                    Some(p) => port = p,
                    None => {
                        eprintln!("--port 需要一个 0-65535 的整数\n{USAGE}");
                        std::process::exit(2);
                    }
                }
            }
            other => {
                eprintln!("未知参数: {other}\n{USAGE}");
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let root = match root {
        Some(r) if !r.is_empty() => r,
        _ => {
            eprintln!("serve 需要 --root <目录>\n{USAGE}");
            std::process::exit(2);
        }
    };

    let service: RunningService = match guanlan_service::start_readonly_service(ServeConfig {
        root,
        port,
        // CLI 同源访问（Vite 代理 / 直接 curl）不需要 CORS
        cors_desktop: false,
        // 缺省只读（契约 §4-3「打开已有数据零扫描」）；--watch 才启动 watcher 与启动对账
        background_index: watch,
    })
    .await
    {
        Ok(s) => s,
        Err(e) => fail_with_envelope(&e),
    };

    // 运行信息（数据目录、实例身份与接口版本）走 stderr，启动阶段不写 index.db
    // （契约 contract-storage.md §4-1）；stdout 只保留一行端点行，供 CLI/启动器逐行解析。
    eprintln!(
        "guanlan serve data_dir={} instance_id={} api_version=v1",
        service.data_dir.display(),
        service.instance_id
    );
    println!("GUANLAN_ENDPOINT={}", service.endpoint);

    service.join().await;
}
