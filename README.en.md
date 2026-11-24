# Guanlan (观澜)

[简体中文](README.md) | **English**

> Chronos keeps time. Guanlan reveals the trace. Every change and decision stays accountable.

Guanlan is a **local-first, zero lock-in** file workbench. It builds a traceable timeline and version snapshots for any directory, ties decisions to the evidence behind them with a relation map and evidence anchors, and ships an all-format reader plus an MCP context base for coding agents.

Every index, snapshot and reading state lives in a private data directory on your machine. Guanlan never writes to or moves your working files on its own, and it does not depend on any cloud service.

The detailed documentation under `docs/` is written in Chinese, and so is the [Chinese README](README.md). This page is a translation of it and may lag behind; where the two differ, the Chinese version is the reference. The links on this page are checked by a test.

## Features

- **Timeline, calendar, star map and Atlas views** of the same workspace, by when things happened, how active they were and how they relate.
- **All-format version time machine**: deduplicated snapshots with SHA-256 content hashes, version chains, format-aware diffs across Markdown, SVG, CSV/TSV, XLSX workbooks and all UTF-8 text/source formats, plus resuming a document at the version you were reading.
- **All-format reader**: Markdown, Office (DOCX/XLSX/PPTX), PDF, SVG, images and plain text or code, plus an **HTML sandbox with no same-origin access** (offline CSP; HTTPS links can be allowed on demand), wrapped in a compact single-row reader header.
- **Read / unread and the Reading Island**: recursive unread counts in the folder tree, marking one file or a whole folder as read or unread, a double-ring marker on documents updated since you read them, and bookmarks and annotations that are never lost.
- **Decisions anchored to evidence**: decisions, evidence pointers, versions and document sections are bound into a causal chain you can audit.
- **Safe context over MCP**: exposes a restricted set of local context tools to MCP-capable agents over stdio, with no arbitrary path download.
- **Light & dark themes, responsive layout & accessibility**: switchable light/dark themes, keyboard navigation and `Esc` dismissal for overlays, touch-friendly targets (≥ 44px), WCAG AA contrast, and offline / SSE disconnect recovery prompts.
- **Desktop app & in-app updates**: a single Tauri v2 package (embedded Rust service and CLI sidecar) with Windows NSIS and MSI installers, plus a manual **Settings → About → Check for updates** flow (never polls in the background; see [auto-update](docs/subsystems/release-pipeline.md#自动更新), Chinese).

## Download & install (Windows)

Download installers and checksums from [GitHub Releases](https://github.com/locooooooooo/guanlan/releases):

- `Guanlan_<version>_x64-setup.exe`: NSIS installer; registers the Windows Explorer “Open this folder with Guanlan” context menu (recommended; supports in-app updates once a release update endpoint is configured).
- `Guanlan_<version>_x64_zh-CN.msi`: MSI installer.
- `guanlan-cli-<version>-x86_64-pc-windows-msvc.exe`: standalone CLI and MCP stdio proxy; rename to `guanlan.exe` and add to `PATH`.
- `SHA256SUMS`: SHA-256 checksums for the three binaries above.

> Installers are not code-signed yet, so Windows may show an unknown publisher warning on first run. Windows 10/11 requires WebView2 (usually preinstalled; the installer embeds the bootstrapper).

## Tech stack

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Web frontend | React 19 · Vite 8 · Tailwind CSS 4 · d3 | Timeline, star map, reader, Atlas and all interaction |
| Domain core | Rust · `guanlan-core` | Domain rules, SQLite index, deduplicated storage, read-only query contracts |
| Read service | Rust · axum · rusqlite (bundled) | `/api/v1` HTTP + SSE, the `guanlan` CLI, MCP stdio |
| Desktop shell | Tauri v2 | In-process service, window and installer |
| Reference pipeline | TypeScript · Node | The early Node pipeline. It is no longer mounted; it is kept as the baseline for the Node ↔ Rust write parity check and as the fixture generator |

## Repository layout

```text
AGENTS.md                    Notes for coding agents: what to read before changing code, and what must not be deleted
src/                        Frontend source (components / stores / services / utils)
test/                       Frontend and contract regression tests (node:test + tsx)
server/                     Early Node pipeline; no longer mounted, kept as the parity baseline and fixture generator
public/                     Static assets
scripts/                    Gate, release preflight, smoke, parity, benchmarks, seed data and installer build
docs/                       Code standards, subsystem references, reference manual, contributor guide
native/
  crates/guanlan-core/      Domain model, index and read-only queries
  crates/guanlan-service/   HTTP/SSE/MCP service and the guanlan CLI
  crates/guanlan-desktop/   Tauri v2 desktop shell
  docs/                     Storage and query API contracts
  testdata/                 Token and stage vectors shared by both sides (committed); other fixtures are generated and not committed
```

## Quick start

### Requirements

- Node.js ≥ 22.13 (CI uses 22 LTS): `server/` depends on the built-in `node:sqlite`, which Node 20 does not have
- Rust 1.99.1 (pinned by `native/rust-toolchain.toml`)
- The Windows desktop app needs WebView2 (built into Windows 10/11)

### 1. Install frontend dependencies

```bash
npm ci
```

This installs exactly what the lockfile says, the same as CI. CI runs on Node 22, whose npm refuses to install when a peer dependency is invalid. One of the `npm test` checks watches the dependency tree; if it goes red, start with `npm ls --all`.

### 2. Start the Rust read service

```bash
cd native
cargo run --locked -p guanlan-service -- serve --root "<your workspace directory>" --port 8787
```

The service listens on `127.0.0.1` only and prints `GUANLAN_ENDPOINT=http://127.0.0.1:<port>` on startup. Indexes and snapshots go to `%LOCALAPPDATA%\Guanlan\workspaces\<rootKey>` by default; `GUANLAN_DATA_DIR` replaces that base entirely.

### 3. Start the frontend

```bash
npm run dev
```

Open <http://localhost:3000>. Vite proxies `/api` to `GUANLAN_SERVE` (default `http://127.0.0.1:8787`).

### Desktop app

```bash
node scripts/build-windows-installer.mjs            # build the MSI and NSIS installers
node scripts/build-windows-installer.mjs --check-only  # validate the packaging config only
```

## Common commands

```bash
npm run dev        # frontend dev server (port 3000)
npm run build      # production build
npm run lint       # TypeScript type check (tsc --noEmit)
npm test           # frontend regression tests
npm run gate       # run before committing: type check, frontend tests, build, packaging config, cargo fmt / clippy / test
npm run preflight  # check that the version number agrees everywhere in the repository
npm run notices    # regenerate the third-party notices index after a dependency or version change
npm run seed       # generate test fixtures
```

`npm run gate` runs both groups of checks below in one command and points the Rust tests' data directory at a temporary location. `npm run gate -- --full` additionally runs the release build, the smoke test and the Node ↔ Rust parity check.

Rust checks:

```bash
cd native
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

Before running `cargo test` directly, point `GUANLAN_DATA_DIR` at a temporary directory. Otherwise the tests write into the same data directory the installed Guanlan uses.

End-to-end smoke tests and benchmarks. The `.ts` scripts run through tsx and all need a release build of `guanlan` first (run `cargo build --release --locked -p guanlan-service` under `native/`):

```bash
npm run seed                                             # generate the fixtures for smoke and parity (not committed)
npx tsx scripts/smoke-v1.ts --exe native/target/release/guanlan.exe
npx tsx scripts/parity-reconcile.ts --exe native/target/release/guanlan.exe   # Node ↔ Rust write parity
npx tsx scripts/bench-f04-golden-tasks.ts                # generates its own thousand-file fixture
npx tsx scripts/seed-bench-volume.ts native/testdata/bench/workspace   # ten-thousand-file fixture shared by the two benchmarks below
npx tsx scripts/bench-v1.ts --exe native/target/release/guanlan.exe
npx tsx scripts/bench-search-v1.ts --exe native/target/release/guanlan.exe
npm run build && node scripts/visual-baseline.mjs capture   # visual baseline: needs dist/ and Chrome or Edge
```

## Connecting an agent over MCP

Start `guanlan serve`, then let the agent start the proxy over stdio:

```bash
GUANLAN_ENDPOINT=http://127.0.0.1:8787 guanlan mcp
```

MCP exposes an allow-list of tools only and never reads arbitrary paths; if the endpoint is missing it fails with a clear error instead of guessing a port. The tool list, the two ways to connect and the known limitations are in the [reference manual](docs/reference.md#mcp-接入) (Chinese).

## Data and privacy

- **Nothing is written to your working directory without your confirmation.** Guanlan never writes, renames or moves your files on its own. The exceptions are the operations you trigger explicitly in the UI, or an agent triggers with authorization: rename, move, move to the system recycle bin, writing a resolved decision back into the document, adopting a revision draft, and writing an MCP host config. Each of them has a human confirmation, optimistic concurrency and path validation. The list is in [workspace writes](docs/subsystems/workspace-writes.md) (Chinese).
- Deletion only moves files to the system recycle bin. There is no permanent deletion.
- Indexes and snapshots stay in the local data directory. Uninstalling the app does not delete the files in your workspace.
- No telemetry and no cloud sync. Outbound network requests only happen when you explicitly turn on “allow HTTPS links” inside a sandboxed HTML page, or when you manually click “Check for updates” in About once an update endpoint is configured (production builds ship with no update endpoint configured and do not make update requests).

## Contracts

- [`native/docs/contract-storage.md`](native/docs/contract-storage.md): storage layout, the three snapshot tiers and integrity checks (Chinese).
- [`native/docs/contract-query-api.md`](native/docs/contract-query-api.md): the `/api/v1` query contract, error envelope and pagination (Chinese).

## Contributing

All of these are written in Chinese.

- [AGENTS.md](AGENTS.md): what to read before changing code, which code that looks like a leftover must not be deleted, and the environment pitfalls. Written for coding agents; useful for people too.
- [Code standards](docs/code-standards.md): what a change contains, tests, acceptance criteria, review, commits and releases.
- [Subsystem references](docs/subsystems/README.md): responsibilities, runtime paths, state and constraints of the twelve subsystems.
- [Reference manual](docs/reference.md): CLI, exit codes, environment variables, data directory and MCP.
- [Contributor guide](docs/contributors.md): how to file an issue or a PR, and what a review checks first.
- [LESSONS.md](LESSONS.md): what merged work got wrong, and the known open problems.

## License

[MIT](LICENSE). The third-party components distributed with the Windows desktop app, and their licenses, are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) (Chinese, with a short English summary at the top). It is an index, not the full license texts, and `npm run notices` generates it.
