//! 项目树与实时指标的目录清单由调用方供给：查询体不再 `read_dir` 工作区。
//!
//! 这条约束对应 5 万文件级工作区的多项目场景：整树目录枚举放进只读连接的查询体里，
//! 会把连接池占满，检索与翻页随之 `INDEX_BUSY`。

use crate::index::collector::FolderListing;
use crate::query::projects::{project_live_metrics, project_tree};
use crate::test_support::{cleanup_dir, open_store, FixtureDb};

#[test]
fn project_tree_returns_supplied_folders_without_reading_disk() {
    let fixture = FixtureDb::new("project-tree-folders");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);
    fixture.file(&ws_id, "f1", "docs/a.md", "md", "方案", "active", None);
    let store = open_store(&fixture, &root);

    let listing = FolderListing {
        folders: vec!["from-cache".to_owned()],
        truncated: false,
        incomplete: false,
    };
    let resp = project_tree(
        &store, "pid", "项目", &root, false, true, "ready", 2000, &listing,
    )
    .expect("项目树查询");

    assert_eq!(resp.total, 1);
    assert_eq!(
        resp.folders,
        vec!["from-cache".to_owned()],
        "目录清单必须原样来自调用方缓存；查询体不得再枚举磁盘"
    );

    cleanup_dir(&fixture.dir);
}

#[test]
fn project_live_metrics_takes_folder_count_from_caller() {
    let fixture = FixtureDb::new("project-metrics-folders");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 3, None);
    fixture.file(&ws_id, "f1", "docs/a.md", "md", "方案", "active", None);
    let store = open_store(&fixture, &root);

    let metrics = project_live_metrics(&store, 42).expect("实时指标");
    assert_eq!(metrics.file_count, 1);
    assert_eq!(
        metrics.folder_count, 42,
        "目录数由调用方供给，度量查询自己不再遍历目录"
    );
    assert_eq!(metrics.index_generation, 3);

    cleanup_dir(&fixture.dir);
}
