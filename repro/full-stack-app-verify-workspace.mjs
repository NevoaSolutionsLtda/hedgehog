#!/usr/bin/env node
// Runtime reproduction for the full-stack-app verify commands fixed in
// `fix(full-stack-app): make every layer's verify command runnable`.
//
// This is the half that scripts/lint-core-verify.mjs cannot decide. The lint
// reads the core definition and catches a flag or a script that does not
// exist. It cannot tell you that `nx test <project> -- <path>` forwards
// positionally to Vitest, that `vitest list` exits 0 without running a test,
// or that a filter matching nothing exits 1. Those are facts about Nx and
// Vitest, only observable by running them.
//
// So this file demonstrates a bug that was fixed once, against a real
// workspace — it is not a permanent property of the shipped product and does
// not belong in the release path.
//
//   mkdir /tmp/<yours> && cd /tmp/<yours> && git init
//   node <hedgehog>/bin/cli.mjs init --ts-full-stack-app
//   cp .env.example .env && pnpm install
//   node <hedgehog>/repro/full-stack-app-verify-workspace.mjs "$PWD"
//
// It scaffolds (idempotently) three modules across all eight layers —
// `board`, `list` and `card`, where "list" and "card" both appear inside a
// file name that belongs to `board` — then runs each layer's verify command
// straight out of the fixed core.yaml, green and red.
//
// It also adds the vitest configs for apps/api and apps/web that the core
// does NOT ship. Without them `nx test api`/`nx test web` fail with "Cannot
// find configuration for task api:test" whatever the filter says — a
// separate, still-open defect, recorded as KNOWN_MISSING_TEST_TARGET in
// scripts/lint-core-verify.mjs.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../src/db/core.mjs';

const WS = process.argv[2];
if (!WS) {
  console.error('usage: node repro/full-stack-app-verify-workspace.mjs <workspace-dir>');
  process.exit(2);
}
const w = async (rel, content) => {
  const p = join(WS, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
};

// `list` and `card` are both substrings of a file name owned by `board`.
// `list` is additionally the name of a Vitest subcommand.
const MODULES = ['board', 'list', 'card'];

const tsconfigLib = (refs = []) =>
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: 'dist/tsconfig.lib.tsbuildinfo',
        emitDeclarationOnly: true,
        forceConsistentCasingInFileNames: true,
        types: ['node'],
      },
      include: ['src/**/*.ts'],
      references: refs,
      exclude: [
        'vite.config.ts',
        'vite.config.mts',
        'vitest.config.ts',
        'vitest.config.mts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
      ],
    },
    null,
    2,
  ) + '\n';

const tsconfigSpec = () =>
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        outDir: './out-tsc/vitest',
        types: ['vitest/globals', 'vitest/importMeta', 'vite/client', 'node', 'vitest'],
        forceConsistentCasingInFileNames: true,
      },
      include: [
        'vite.config.ts',
        'vite.config.mts',
        'vitest.config.ts',
        'vitest.config.mts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
      ],
      references: [{ path: './tsconfig.lib.json' }],
    },
    null,
    2,
  ) + '\n';

const tsconfigRoot = () =>
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      files: [],
      include: [],
      references: [{ path: './tsconfig.lib.json' }, { path: './tsconfig.spec.json' }],
    },
    null,
    2,
  ) + '\n';

const vitestConfig = (name, cacheDir) => `import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '${cacheDir}',
  test: {
    name: '${name}',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
`;

const pkg = (name, tags) =>
  JSON.stringify(
    {
      name,
      version: '0.0.1',
      private: true,
      type: 'module',
      main: './src/index.ts',
      types: './src/index.ts',
      exports: {
        '.': { types: './src/index.ts', import: './src/index.ts', default: './src/index.ts' },
        './package.json': './package.json',
      },
      nx: { tags },
    },
    null,
    2,
  ) + '\n';

// ── new packages: contracts, hooks ────────────────────────────────────
for (const [name, dir, cacheDepth] of [
  ['contracts', 'packages/contracts', '../..'],
  ['hooks', 'packages/hooks', '../..'],
]) {
  await w(`${dir}/package.json`, pkg(name, [`scope:${name}`, 'type:util']));
  await w(`${dir}/tsconfig.json`, tsconfigRoot());
  await w(`${dir}/tsconfig.lib.json`, tsconfigLib());
  await w(`${dir}/tsconfig.spec.json`, tsconfigSpec());
  await w(`${dir}/vitest.config.mts`, vitestConfig(name, `${cacheDepth}/node_modules/.vite/${dir}`));
  await w(`${dir}/src/index.ts`, `export const ${name}Marker = '${name}';\n`);
}

// ── apps/mobile (stand-in for the Mobile add-on's Expo app) ───────────
await w('apps/mobile/package.json', pkg('mobile', ['scope:mobile']));
await w('apps/mobile/tsconfig.json', tsconfigRoot());
await w('apps/mobile/tsconfig.lib.json', tsconfigLib());
await w('apps/mobile/tsconfig.spec.json', tsconfigSpec());
await w('apps/mobile/vitest.config.mts', vitestConfig('mobile', '../../node_modules/.vite/apps/mobile'));
await w('apps/mobile/src/index.ts', `export const mobileMarker = 'mobile';\n`);

// ── libs/<module>/{repository,service} ────────────────────────────────
for (const m of MODULES) {
  for (const kind of ['repository', 'service']) {
    const dir = `libs/${m}/${kind}`;
    await w(`${dir}/package.json`, pkg(`${m}-${kind}`, [`scope:${m}`, 'type:feature']));
    await w(
      `${dir}/tsconfig.json`,
      JSON.stringify(
        {
          extends: '../../../tsconfig.base.json',
          files: [],
          include: [],
          references: [{ path: './tsconfig.lib.json' }, { path: './tsconfig.spec.json' }],
        },
        null,
        2,
      ) + '\n',
    );
    await w(`${dir}/tsconfig.lib.json`, tsconfigLib().replace(/\.\.\/\.\.\/tsconfig/g, '../../../tsconfig'));
    await w(`${dir}/tsconfig.spec.json`, tsconfigSpec().replace(/\.\.\/\.\.\/tsconfig/g, '../../../tsconfig'));
    await w(
      `${dir}/vitest.config.mts`,
      vitestConfig(`${m}-${kind}`, `../../../node_modules/.vite/${dir}`),
    );
    await w(`${dir}/src/index.ts`, `export function ${kind}Name(): string {\n  return '${m}-${kind}';\n}\n`);
    await w(
      `${dir}/src/index.spec.ts`,
      `import { describe, expect, it } from 'vitest';\nimport { ${kind}Name } from './index.js';\n\ndescribe('${m} ${kind}', () => {\n  it('names itself', () => {\n    expect(${kind}Name()).toBe('${m}-${kind}');\n  });\n});\n`,
    );
  }
}

// ── per-module layer files ────────────────────────────────────────────
const unit = (fn, value) => `export function ${fn}(): string {\n  return '${value}';\n}\n`;
const spec = (label, fn, value, importPath) =>
  `import { describe, expect, it } from 'vitest';\nimport { ${fn} } from '${importPath}';\n\ndescribe('${label}', () => {\n  it('returns its marker', () => {\n    expect(${fn}()).toBe('${value}');\n  });\n});\n`;

for (const m of MODULES) {
  const M = m[0].toUpperCase() + m.slice(1);

  // schema  → packages/db/src/schema/<m>/
  await w(`packages/db/src/schema/${m}/${m}.ts`, unit(`${m}Table`, `${m}-schema`));
  await w(
    `packages/db/src/schema/${m}/${m}.spec.ts`,
    spec(`${m} schema`, `${m}Table`, `${m}-schema`, `./${m}.js`),
  );

  // contract → packages/contracts/src/<m>/
  await w(`packages/contracts/src/${m}/${m}.contract.ts`, unit(`${m}Contract`, `${m}-contract`));
  await w(
    `packages/contracts/src/${m}/${m}.contract.spec.ts`,
    spec(`${m} contract`, `${m}Contract`, `${m}-contract`, `./${m}.contract.js`),
  );

  // controller → apps/api/src/app/<m>/
  await w(`apps/api/src/app/${m}/${m}.controller.ts`, unit(`${m}Controller`, `${m}-controller`));
  await w(
    `apps/api/src/app/${m}/${m}.controller.spec.ts`,
    spec(`${m} controller`, `${m}Controller`, `${m}-controller`, `./${m}.controller.js`),
  );

  // hook → packages/hooks/src/<m>/
  await w(`packages/hooks/src/${m}/use-${m}.ts`, unit(`use${M}`, `${m}-hook`));
  await w(
    `packages/hooks/src/${m}/use-${m}.spec.ts`,
    spec(`use${M}`, `use${M}`, `${m}-hook`, `./use-${m}.js`),
  );

  // screen → apps/web/src/app/<m>/ and apps/mobile/src/<m>/
  await w(`apps/web/src/app/${m}/${m}-screen.ts`, unit(`${m}Screen`, `${m}-web-screen`));
  await w(
    `apps/web/src/app/${m}/${m}-screen.spec.ts`,
    spec(`${m} web screen`, `${m}Screen`, `${m}-web-screen`, `./${m}-screen.js`),
  );
  await w(`apps/mobile/src/${m}/${m}-screen.ts`, unit(`${m}MobileScreen`, `${m}-mobile-screen`));
  await w(
    `apps/mobile/src/${m}/${m}-screen.spec.ts`,
    spec(`${m} mobile screen`, `${m}MobileScreen`, `${m}-mobile-screen`, `./${m}-screen.js`),
  );
}

// ── the anchoring trap: `board`-owned files whose NAMES contain the other
//    two module names, so an unanchored filter reaches across modules ────
for (const other of ['lists', 'cards']) {
  const fn = `useBoard${other[0].toUpperCase()}${other.slice(1)}`;
  await w(`packages/hooks/src/board/use-board-${other}.ts`, unit(fn, `board-${other}-hook`));
  await w(
    `packages/hooks/src/board/use-board-${other}.spec.ts`,
    spec(fn, fn, `board-${other}-hook`, `./use-board-${other}.js`),
  );
}

// ── test targets for apps/api and apps/web ────────────────────────────
// NOT shipped by the core (confirmed: neither app has a vitest config, so
// neither has an `nx test` target). Added here, modelled on what a real
// full-stack-app project had to hand-add, so the controller and screen
// verify commands have a target to run at all.
await w('apps/api/vitest.config.mts', vitestConfig('api', '../../node_modules/.vite/apps/api'));
await w('apps/web/vitest.config.mts', vitestConfig('web', '../../node_modules/.vite/apps/web'));
await w(
  'apps/api/tsconfig.spec.json',
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        outDir: './out-tsc/vitest',
        composite: true,
        declaration: true,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: 'es2021',
        types: ['vitest/globals', 'vitest/importMeta', 'vite/client', 'node', 'vitest'],
        forceConsistentCasingInFileNames: true,
      },
      include: ['vitest.config.mts', 'src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.d.ts'],
      references: [{ path: './tsconfig.app.json' }],
    },
    null,
    2,
  ) + '\n',
);
await w(
  'apps/web/tsconfig.spec.json',
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        outDir: './out-tsc/vitest',
        composite: true,
        declaration: true,
        emitDeclarationOnly: true,
        jsx: 'react-jsx',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        lib: ['dom', 'dom.iterable', 'esnext'],
        rootDir: '.',
        paths: { '@/*': ['./src/*'] },
        types: ['vitest/globals', 'vitest/importMeta', 'vite/client', 'node', 'vitest'],
        forceConsistentCasingInFileNames: true,
      },
      include: [
        'vitest.config.mts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.test.tsx',
        'src/**/*.spec.tsx',
        'src/**/*.d.ts',
      ],
      references: [],
    },
    null,
    2,
  ) + '\n',
);
{
  const addRef = (refs, path) =>
    refs.some((r) => r.path === path) ? refs : [...refs, { path }];
  const addAll = (list, items) => [...new Set([...list, ...items])];

  const apiTs = JSON.parse(await readFile(join(WS, 'apps/api/tsconfig.json'), 'utf8'));
  apiTs.references = addRef(apiTs.references, './tsconfig.spec.json');
  await w('apps/api/tsconfig.json', JSON.stringify(apiTs, null, 2) + '\n');

  const webTs = JSON.parse(await readFile(join(WS, 'apps/web/tsconfig.json'), 'utf8'));
  webTs.exclude = addAll(webTs.exclude, [
    'src/**/*.spec.tsx',
    'src/**/*.test.tsx',
    'vitest.config.mts',
  ]);
  webTs.references = addRef(webTs.references, './tsconfig.spec.json');
  await w('apps/web/tsconfig.json', JSON.stringify(webTs, null, 2) + '\n');
}

// ── workspace wiring ──────────────────────────────────────────────────
await writeFile(
  join(WS, 'pnpm-workspace.yaml'),
  "packages:\n  - 'packages/*'\n  - 'apps/*'\n  - 'libs/*/*'\n",
);

const rootTs = JSON.parse(await readFile(join(WS, 'tsconfig.json'), 'utf8'));
const extraRefs = [
  './packages/contracts',
  './packages/hooks',
  './apps/mobile',
  ...MODULES.flatMap((m) => [`./libs/${m}/repository`, `./libs/${m}/service`]),
];
rootTs.references = [
  ...rootTs.references,
  ...extraRefs.filter((p) => !rootTs.references.some((r) => r.path === p)).map((path) => ({ path })),
];
await writeFile(join(WS, 'tsconfig.json'), JSON.stringify(rootTs, null, 2) + '\n');

console.log(`fixture scaffolded in ${WS} (modules: ${MODULES.join(', ')})\n`);

// ══ Run phase ═════════════════════════════════════════════════════════
const HEDGEHOG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = await loadCore(join(HEDGEHOG_ROOT, 'src/golden-cores/full-stack-app/core.yaml'));

const run = (cmd) => {
  try {
    execSync(cmd, {
      cwd: WS,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, NX_SKIP_NX_CACHE: 'true' },
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
};

// The artifact each layer owns for module `board`, and the exported function
// in it, so the run phase can break exactly one thing per layer. `join` gets
// a MOBILE-only break on purpose: `screen` no longer verifies apps/mobile,
// so join is what has to catch it.
const OWNED = {
  schema: ['packages/db/src/schema/board/board.ts', 'boardTable'],
  contract: ['packages/contracts/src/board/board.contract.ts', 'boardContract'],
  repository: ['libs/board/repository/src/index.ts', 'repositoryName'],
  service: ['libs/board/service/src/index.ts', 'serviceName'],
  controller: ['apps/api/src/app/board/board.controller.ts', 'boardController'],
  hook: ['packages/hooks/src/board/use-board.ts', 'useBoard'],
  screen: ['apps/web/src/app/board/board-screen.ts', 'boardScreen'],
  join: ['apps/mobile/src/board/board-screen.ts', 'boardMobileScreen'],
};

let bad = 0;
const row = (a, b, c, d) =>
  console.log(`${a.padEnd(11)} ${String(b).padEnd(6)} ${String(c).padEnd(6)} ${d}`);

console.log('── every layer, verbatim from core.yaml (module=board) ──');
row('layer', 'green', 'red', 'command');
for (const layer of core.layers) {
  const cmd = layer.verify.replaceAll('{module}', 'board');
  const green = run(cmd);

  const [file, fn] = OWNED[layer.id];
  const original = await readFile(join(WS, file), 'utf8');
  await writeFile(join(WS, file), `export function ${fn}(): string {\n  return 'WRONG';\n}\n`);
  const red = run(cmd);
  await writeFile(join(WS, file), original);

  if (green !== 0 || red === 0) bad++;
  row(layer.id, green, red, cmd);
}
console.log('\ngreen must be 0 (passes on good code); red must be non-zero');
console.log('(a gate that runs but cannot fail is the defect this branch removes)\n');

// ── The two runtime facts no static lint can decide ───────────────────
console.log('── anchoring: unanchored filter vs. anchored filter ──');
{
  // `list` is a Vitest subcommand: it prints the collected tests and exits 0.
  const file = join(WS, 'packages/hooks/src/list/use-list.ts');
  const original = await readFile(file, 'utf8');
  await writeFile(file, `export function useList(): string {\n  return 'WRONG';\n}\n`);
  const unanchored = run('pnpm nx test hooks -- list');
  const anchored = run('pnpm nx test hooks -- src/list/');
  await writeFile(file, original);
  if (unanchored === 0 && anchored !== 0) {
    console.log(
      `  broken list hook: \`-- list\` exit ${unanchored} (\`vitest list\` is a subcommand — ` +
        `gate cannot fail), \`-- src/list/\` exit ${anchored}`,
    );
  } else {
    bad++;
    console.log(`  UNEXPECTED: -- list exit ${unanchored}, -- src/list/ exit ${anchored}`);
  }
}
{
  // A bare `card` is a substring match, so it also selects board's file.
  const file = join(WS, 'packages/hooks/src/board/use-board-cards.ts');
  const original = await readFile(file, 'utf8');
  await writeFile(
    file,
    `export function useBoardCards(): string {\n  return 'WRONG';\n}\n`,
  );
  const unanchored = run('pnpm nx test hooks -- card');
  const anchored = run('pnpm nx test hooks -- src/card/');
  await writeFile(file, original);
  if (unanchored !== 0 && anchored === 0) {
    console.log(
      `  broken BOARD hook: \`-- card\` exit ${unanchored} (board's breakage wrongly fails ` +
        `card's gate), \`-- src/card/\` exit ${anchored} (isolated)`,
    );
  } else {
    bad++;
    console.log(`  UNEXPECTED: -- card exit ${unanchored}, -- src/card/ exit ${anchored}`);
  }
}
{
  // A filter matching nothing exits 1, so a layer that lands source with no
  // test is caught rather than waved through.
  await w('packages/db/src/schema/untested/untested.ts', 'export const x = 1;\n');
  const code = run('pnpm nx test db -- src/schema/untested/');
  execSync(`rm -rf ${JSON.stringify(join(WS, 'packages/db/src/schema/untested'))}`);
  if (code !== 0) console.log(`\n  source with no test: exit ${code} ("No test files found")`);
  else {
    bad++;
    console.log(`\n  UNEXPECTED: source with no test passed (exit ${code})`);
  }
}

console.log(bad === 0 ? '\nreproduction OK' : `\n${bad} unexpected result(s)`);
process.exit(bad === 0 ? 0 : 1);
