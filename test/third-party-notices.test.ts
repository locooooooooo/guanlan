import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fingerprint,
  formatNotices,
  npmRowsFromLock,
  packageOfModuleId,
  parseCargoTreeLine,
  parseNotices,
  rowsDigest,
  rustRowsFrom,
} from '../scripts/gen-third-party-notices.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');
const noticesText = read('THIRD_PARTY_NOTICES').replace(/\r\n/g, '\n');
const notices = parseNotices(noticesText);

const rowKey = (row: { name: string; version: string }) => `${row.name}@${row.version}`;

function npmLockLicenses(): Map<string, Set<string>> {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { version: string; license?: string }>;
  };
  const out = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const keyOf = `${name}@${entry.version}`;
    if (!out.has(keyOf)) out.set(keyOf, new Set());
    if (entry.license) out.get(keyOf)!.add(entry.license);
  }
  return out;
}

function cargoLockCrates(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const block of read('native/Cargo.lock').split('[[package]]').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    assert.ok(name && version, `Cargo.lock 里有一个包块缺 name 或 version：${block.slice(0, 80)}`);
    out.set(`${name}@${version}`, !/^source = /m.test(block));
  }
  return out;
}

describe('第三方许可索引：与当前的依赖对得上', () => {
  it('文件里记着的两份锁文件的 SHA-256 就是当前这两份——依赖变了却没有重新生成时，这里会红', () => {
    for (const file of ['package-lock.json', 'native/Cargo.lock']) {
      assert.equal(
        notices.fingerprints[file],
        fingerprint(readFileSync(join(repo, file))),
        `${file} 变了：执行 npm run notices 重新生成 THIRD_PARTY_NOTICES，并与锁文件一起提交`,
      );
    }
  });

  it('文件里记着的两张表的 SHA-256 与表里的内容一致——表里任何一处手工改动都会让这里红', () => {
    assert.equal(notices.digests.npm, rowsDigest(notices.npm), '前端的表被手工改过');
    assert.equal(notices.digests.rust, rowsDigest(notices.rust), 'Rust 的表被手工改过');
  });

  it('列出的每个 npm 包都在 package-lock.json 里，版本与许可都相同', () => {
    const locked = npmLockLicenses();
    assert.deepEqual(
      notices.npm.filter((row) => !locked.has(rowKey(row))).map(rowKey),
      [],
      '有包不在 package-lock.json 里，或者版本对不上',
    );
    assert.deepEqual(
      notices.npm.filter((row) => !locked.get(rowKey(row))?.has(row.license)).map((row) => `${rowKey(row)} 写的是 ${row.license}`),
      [],
      '有包的许可与 package-lock.json 里声明的不同',
    );
  });

  it('列出的每个 crate 都在 native/Cargo.lock 里、版本相同，并且没有本仓库自己的 crate', () => {
    const locked = cargoLockCrates();
    assert.deepEqual(
      notices.rust.filter((row) => !locked.has(rowKey(row))).map(rowKey),
      [],
      '有 crate 不在 native/Cargo.lock 里，或者版本对不上',
    );
    assert.deepEqual(
      notices.rust.filter((row) => locked.get(rowKey(row)) === true).map((row) => row.name),
      [],
      '本仓库自己的 crate 不是第三方组件',
    );
  });

  it('两节的行数与标题里写的个数一致', () => {
    const npmTitle = /^一、.*（(\d+) 个）$/m.exec(noticesText);
    const rustTitle = /^二、.*（(\d+) 个）$/m.exec(noticesText);
    assert.ok(npmTitle && rustTitle, '找不到两节的标题');
    assert.equal(Number(npmTitle[1]), notices.npm.length);
    assert.equal(Number(rustTitle[1]), notices.rust.length);
  });

  it('取的是真实分发的那些：该在的在，不进发行包的构建工具不在', () => {
    const npmNames = notices.npm.map((row) => row.name);
    const rustNames = notices.rust.map((row) => row.name);
    for (const name of ['react', 'react-dom', 'scheduler', 'd3-selection', 'lucide-react', 'tailwindcss']) {
      assert.ok(npmNames.includes(name), `前端清单里应当有 ${name}`);
    }
    for (const name of ['tauri', 'rusqlite', 'libsqlite3-sys', 'axum', 'tokio', 'windows']) {
      assert.ok(rustNames.includes(name), `Rust 清单里应当有 ${name}`);
    }
    for (const name of ['vite', 'rolldown', '@vitejs/plugin-react', '@tailwindcss/vite', '@tailwindcss/oxide', 'lightningcss']) {
      assert.ok(!npmNames.includes(name), `前端清单里不该有 ${name}：它是构建工具`);
    }
    for (const name of ['typescript', 'tsx', 'esbuild']) {
      assert.ok(!npmNames.includes(name), `前端清单里不该有 ${name}：它是开发工具`);
    }
    assert.ok(npmNames.length >= 20, `前端只列了 ${npmNames.length} 个包，少于预期`);
    assert.ok(rustNames.length >= 200, `Rust 只列了 ${rustNames.length} 个 crate，少于预期`);
  });

  it('样式表那一行注明了它为什么在清单里', () => {
    const tailwind = notices.npm.find((row) => row.name === 'tailwindcss');
    assert.ok(tailwind, '清单里没有 tailwindcss');
    assert.match(tailwind.note ?? '', /样式表/);
  });

  it('rusqlite 开着 bundled 特性时，文件里说明了 SQLite 的许可；关掉后不再说明', () => {
    const bundled = /rusqlite\s*=\s*\{[^}]*"bundled"/.test(read('native/Cargo.toml'));
    assert.equal(notices.bundledSqlite, bundled);
    if (bundled) assert.match(noticesText, /libsqlite3-sys 编入的 SQLite 源码由其作者声明为放弃版权/);
  });

  it('文件就是生成器对它自己的内容会写出的样子——手工改过的文件在这里红', () => {
    assert.equal(
      formatNotices({
        npm: notices.npm,
        rust: notices.rust,
        bundledSqlite: notices.bundledSqlite,
        fingerprints: notices.fingerprints,
      }),
      noticesText,
    );
  });
});

describe('第三方许可索引：模块 id 对应到锁文件里的哪个包', () => {
  const root = 'F:\\GuanLan';

  it('普通的包与带作用域的包', () => {
    assert.equal(packageOfModuleId('F:/GuanLan/node_modules/react/index.js', root), 'node_modules/react');
    assert.equal(packageOfModuleId('F:/GuanLan/node_modules/@floating-ui/react-dom/dist/index.mjs', root), 'node_modules/@floating-ui/react-dom');
  });

  it('同一个包有嵌套安装时取最深的那个，因为磁盘上被加载的就是它', () => {
    assert.equal(packageOfModuleId('F:/GuanLan/node_modules/a/node_modules/react/index.js', root), 'node_modules/a/node_modules/react');
  });

  it('反斜杠、盘符大小写与查询串都不影响结果', () => {
    assert.equal(packageOfModuleId('F:\\GuanLan\\node_modules\\react\\index.js', root), 'node_modules/react');
    assert.equal(packageOfModuleId('f:/guanlan/node_modules/react/index.js', root), 'node_modules/react');
    assert.equal(packageOfModuleId('F:/GuanLan/node_modules/react/index.js?v=abc123', root), 'node_modules/react');
    assert.equal(packageOfModuleId('F:/GuanLan/node_modules/react?commonjs-exports', root), 'node_modules/react');
  });

  it('仓库自己的文件、插件生成的虚拟模块与打包产物的文件名都不是第三方包', () => {
    assert.equal(packageOfModuleId('F:/GuanLan/src/App.tsx', root), null);
    assert.equal(packageOfModuleId('\0F:/GuanLan/node_modules/react/index.js?commonjs-proxy', root), null);
    assert.equal(packageOfModuleId('\0vite/modulepreload-polyfill', root), null);
    assert.equal(packageOfModuleId('assets/index-BuUSCYs-.css', root), null);
  });

  it('仓库本身位于 node_modules 目录下时，不把仓库路径里的那一段当成包', () => {
    assert.equal(
      packageOfModuleId('D:/work/node_modules/site/node_modules/react/index.js', 'D:/work/node_modules/site/'),
      'node_modules/react',
    );
  });
});

describe('第三方许可索引：cargo tree 的哪一行是包', () => {
  it('名字与版本之后的东西都忽略：特性标记、去重标记、路径来源的 crate', () => {
    assert.deepEqual(parseCargoTreeLine('serde v1.0.229'), { name: 'serde', version: '1.0.229' });
    assert.deepEqual(parseCargoTreeLine('thiserror-impl v2.0.17 (proc-macro)'), { name: 'thiserror-impl', version: '2.0.17' });
    assert.deepEqual(parseCargoTreeLine('rusqlite v0.42.0 (*)'), { name: 'rusqlite', version: '0.42.0' });
    assert.deepEqual(parseCargoTreeLine('guanlan-core v1.2.0 (F:\\work\\native\\crates\\guanlan-core) (*)'), {
      name: 'guanlan-core',
      version: '1.2.0',
    });
  });

  it('特性行与空行不是包', () => {
    assert.equal(parseCargoTreeLine('libsqlite3-sys feature "bundled"'), null);
    assert.equal(parseCargoTreeLine(''), null);
  });
});

describe('第三方许可索引：由构建结果与锁文件得到前端一侧的行', () => {
  const repo = 'F:/GuanLan';
  const lock = {
    packages: {
      'node_modules/react': { version: '19.3.1', license: 'MIT' },
      'node_modules/vite': { version: '8.3.6', license: 'MIT' },
      'node_modules/a/node_modules/react': { version: '18.0.0', license: 'MIT' },
      'node_modules/some-font': { version: '1.0.0', license: 'OFL-1.1' },
      'node_modules/tailwindcss': { version: '4.3.4', license: 'MIT' },
      'node_modules/d3': { version: '7.9.2', license: 'ISC' },
      'node_modules/d3-selection': { version: '3.0.1', license: 'ISC' },
      'node_modules/no-license': { version: '1.0.0' },
    },
  };

  it('只列模块出现在产物里的包；锁文件里有、产物里没有的不列', () => {
    const rows = npmRowsFromLock(lock, ['F:/GuanLan/node_modules/react/index.js', 'F:/GuanLan/src/main.tsx'], [], [], repo);
    assert.deepEqual(rows, [{ name: 'react', version: '19.3.1', license: 'MIT' }]);
  });

  it('由包里的文件原样发出的资源也算', () => {
    const rows = npmRowsFromLock(lock, [], ['F:/GuanLan/node_modules/some-font/font.woff2', 'assets/index-abc.css'], [], repo);
    assert.deepEqual(rows.map((row) => row.name), ['some-font']);
  });

  it('构建里挂着 @tailwindcss/vite 时单列 tailwindcss 并注明；没挂时不列', () => {
    const withPlugin = npmRowsFromLock(lock, [], [], ['vite:build-import-analysis', '@tailwindcss/vite:generate:build'], repo);
    assert.deepEqual(withPlugin, [{ name: 'tailwindcss', version: '4.3.4', license: 'MIT', note: '样式表 dist/assets/*.css 由它生成' }]);
    assert.deepEqual(npmRowsFromLock(lock, [], [], ['vite:build-import-analysis'], repo), []);
  });

  it('应用代码按名字导入、自己却没有代码进产物的包也列并注明；已有代码在产物里的不重复列', () => {
    const rows = npmRowsFromLock(
      lock,
      ['F:/GuanLan/node_modules/d3-selection/src/index.js', 'F:/GuanLan/node_modules/react/index.js'],
      [],
      [],
      repo,
      ['F:/GuanLan/node_modules/d3/dist/d3.mjs', 'F:/GuanLan/node_modules/react/index.js', 'F:/GuanLan/src/components/AtlasView.tsx'],
    );
    assert.deepEqual(rows, [
      { name: 'd3', version: '7.9.2', license: 'ISC', note: '应用代码导入了它，它自己没有代码进产物' },
      { name: 'd3-selection', version: '3.0.1', license: 'ISC' },
      { name: 'react', version: '19.3.1', license: 'MIT' },
    ]);
  });

  it('结果按名字排序', () => {
    const rows = npmRowsFromLock(
      lock,
      ['F:/GuanLan/node_modules/vite/index.js', 'F:/GuanLan/node_modules/react/index.js', 'F:/GuanLan/node_modules/some-font/font.woff2'],
      [],
      [],
      repo,
    );
    assert.deepEqual(rows.map((row) => row.name), ['react', 'some-font', 'vite']);
  });

  it('构建用到了锁文件里没有的包时报错，而不是漏掉它', () => {
    assert.throws(() => npmRowsFromLock(lock, ['F:/GuanLan/node_modules/unknown/index.js'], [], [], repo), /unknown.*npm ci/);
  });

  it('包没有声明许可时报错，而不是写一个猜的', () => {
    assert.throws(() => npmRowsFromLock(lock, ['F:/GuanLan/node_modules/no-license/index.js'], [], [], repo), /no-license@1\.0\.0 没有 license 字段/);
  });
});

describe('第三方许可索引：由 cargo tree 与 cargo metadata 得到 Rust 一侧的行', () => {
  const own = { id: 'path+file:///F:/work/native/crates/guanlan-core#1.2.0', name: 'guanlan-core', version: '1.2.0' };
  const metadata = {
    workspace_members: [own.id],
    packages: [
      own,
      { id: 'reg#rusqlite#0.42.0', name: 'rusqlite', version: '0.42.0', license: 'MIT' },
      { id: 'reg#libsqlite3-sys#0.40.0', name: 'libsqlite3-sys', version: '0.40.0', license: 'MIT' },
      { id: 'reg#thiserror-impl#2.0.17', name: 'thiserror-impl', version: '2.0.17', license: 'MIT' },
      { id: 'reg#mystery#0.1.0', name: 'mystery', version: '0.1.0', license_file: 'LICENSE.txt' },
    ],
  };
  const tree = [
    `guanlan-core v1.2.0 (F:\\work\\native\\crates\\guanlan-core)`,
    'rusqlite v0.42.0',
    'rusqlite feature "bundled"',
    'rusqlite v0.42.0 (*)',
    'libsqlite3-sys v0.40.0',
    'libsqlite3-sys feature "bundled" (*)',
    'thiserror-impl v2.0.17 (proc-macro)',
    '',
  ].join('\n');

  it('每个包一行，重复出现的只算一次，本仓库自己的 crate 不列', () => {
    const { rows } = rustRowsFrom(tree, metadata);
    assert.deepEqual(rows, [
      { name: 'libsqlite3-sys', version: '0.40.0', license: 'MIT' },
      { name: 'rusqlite', version: '0.42.0', license: 'MIT' },
      { name: 'thiserror-impl', version: '2.0.17', license: 'MIT' },
    ]);
  });

  it('libsqlite3-sys 的 bundled 特性开着才算编入了 SQLite 源码', () => {
    assert.equal(rustRowsFrom(tree, metadata).bundledSqlite, true);
    assert.equal(rustRowsFrom(tree.replace('libsqlite3-sys feature "bundled" (*)', 'libsqlite3-sys feature "default"'), metadata).bundledSqlite, false);
  });

  it('cargo tree 列了、cargo metadata 里却没有的包报错', () => {
    assert.throws(() => rustRowsFrom(`${tree}\nghost v9.9.9\n`, metadata), /ghost@9\.9\.9.*cargo metadata/);
  });

  it('crate 没有声明 license 字段时报错，并指出它有许可文件', () => {
    assert.throws(
      () => rustRowsFrom(`${tree}\nmystery v0.1.0\n`, metadata),
      /mystery@0\.1\.0 没有声明 license 字段，只有许可文件 LICENSE\.txt/,
    );
  });
});

describe('第三方许可索引：文件的写法与读法', () => {
  const model = {
    npm: [
      { name: 'react', version: '19.3.1', license: 'MIT' },
      { name: 'tailwindcss', version: '4.3.4', license: 'MIT', note: '样式表 dist/assets/*.css 由它生成' },
    ],
    rust: [
      { name: 'anyhow', version: '1.0.104', license: 'MIT OR Apache-2.0' },
      { name: 'adler2', version: '2.0.1', license: '0BSD OR MIT OR Apache-2.0' },
    ],
    bundledSqlite: true,
    fingerprints: { 'package-lock.json': 'a'.repeat(64), 'native/Cargo.lock': 'b'.repeat(64) },
  };

  it('写出来的文件读回去是同一份内容，标题里的个数随行数变', () => {
    const text = formatNotices(model);
    assert.match(text, /^一、.*（2 个）$/m);
    assert.match(text, /^二、.*（2 个）$/m);
    const parsed = parseNotices(text);
    assert.deepEqual(
      { npm: parsed.npm, rust: parsed.rust, bundledSqlite: parsed.bundledSqlite, fingerprints: parsed.fingerprints },
      model,
    );
    assert.deepEqual(parsed.digests, { npm: rowsDigest(model.npm), rust: rowsDigest(model.rust) });
  });

  it('表的摘要只取决于每个组件的名字、版本、许可与备注，与对齐无关', () => {
    const base = { name: 'anyhow', version: '1.0.104', license: 'MIT OR Apache-2.0' };
    assert.equal(rowsDigest([base]), rowsDigest([{ ...base }]));
    for (const changed of [
      { ...base, license: 'Apache-2.0 OR MIT' },
      { ...base, version: '1.0.105' },
      { ...base, name: 'anyhow2' },
      { ...base, note: '说明' },
    ]) {
      assert.notEqual(rowsDigest([changed]), rowsDigest([base]), `${JSON.stringify(changed)} 的摘要不该相同`);
    }
    assert.notEqual(rowsDigest([base, model.rust[1]]), rowsDigest([model.rust[1], base]));
  });

  it('没有编入 SQLite 时不写那句说明；许可表达式里的空格不会被当成列的分隔', () => {
    const parsed = parseNotices(formatNotices({ ...model, bundledSqlite: false }));
    assert.equal(parsed.bundledSqlite, false);
    assert.deepEqual(parsed.rust, model.rust);
  });

  it('SHA-256 对 CRLF 与 LF 算出同一个值，内容变了就不同', () => {
    assert.equal(fingerprint('a\r\nb\r\n'), fingerprint('a\nb\n'));
    assert.equal(fingerprint(Buffer.from('a\r\nb\r\n')), fingerprint('a\nb\n'));
    assert.notEqual(fingerprint('a\nb\n'), fingerprint('a\nc\n'));
    assert.match(fingerprint('x'), /^[0-9a-f]{64}$/);
  });
});
