#!/usr/bin/env node
// Verify-command lint for the shipped Golden Cores. Imported by
// scripts/check.mjs (so `pnpm check`, and the publish gate behind it, fails
// on a broken verify command) and runnable on its own:
//
//   node scripts/lint-core-verify.mjs
//
// A core's verify command is the only thing standing between a task and a
// commit, and it is the one part of a core definition that is never
// exercised by building this package — it runs in a consuming project,
// against a workspace this repo never installs. So the failure mode is a
// core that ships, is installed, and only then turns out to gate nothing.
// That is what happened in 4.0.3, three ways:
//
//   1. `pnpm nx test db --testPathPattern={module}`, and five more like it.
//      `--testPathPattern` is a Jest flag; full-stack-app pins
//      `vitest ~4.1.0`, and Vitest's CLI rejects unknown options outright —
//      `CACError: Unknown option --testPathPattern` — so the gate aborted
//      before running a single test and could never pass.
//
//   2. `pnpm typecheck && pnpm nx run-many -t test` on the join layer,
//      naming a root script the core has never defined (its only script is
//      `dev`): `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "typecheck" not
//      found`.
//
//   3. A bare `{module}` as the test filter. Vitest matches a positional
//      filter as a substring of the whole test file path, so a module named
//      `card` also selected `src/board/use-board-cards.spec.ts`, and a
//      module named `list` was swallowed by `vitest list` — Vitest's
//      list-collected-tests subcommand, which prints the collected tests and
//      exits 0. A gate that cannot fail.
//
// All three are decidable from the core definition and the core's own
// shipped tree: no workspace, no install, no network. The checks below are
// paired with a regression fixture holding the literal 4.0.3 strings, so the
// lint cannot quietly stop detecting what it was written for.

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoreYaml, validateCore } from '../src/db/core.mjs';

// ── Flags that belong to Jest and do not exist in Vitest's CLI. Vitest
//    exits on the first unknown option, so any of these is a gate that can
//    never pass. ────────────────────────────────────────────────────────
const JEST_ONLY_FLAGS = [
  'testPathPattern',
  'testPathPatterns',
  'testPathIgnorePatterns',
  'runTestsByPath',
  'runInBand',
  'detectOpenHandles',
  'forceExit',
  'collectCoverageFrom',
  'moduleNameMapper',
  'setupFilesAfterEnv',
  'testMatch',
  'roots',
];

// ── `pnpm <word>` is a package.json script unless <word> is one of pnpm's
//    own subcommands or a binary from a declared dependency. ────────────
const PNPM_SUBCOMMANDS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'env',
  'exec', 'fetch', 'i', 'import', 'init', 'install', 'licenses', 'link', 'list',
  'ls', 'outdated', 'pack', 'patch', 'prune', 'publish', 'rebuild', 'remove',
  'root', 'run', 'server', 'setup', 'start', 'store', 'test', 'unlink', 'update',
  'why',
]);

// ── Projects a core ships whose `nx test` target does not exist yet. Each
//    entry is a known-open defect, not a style exemption: the shipped
//    apps/api and apps/web carry no vitest config, so they have no `test`
//    target, and a verify naming `nx test api`/`nx test web` dies with
//    "Cannot find configuration for task api:test" no matter how the filter
//    is spelled. Closing it means adding a vitest config, a spec, and (for
//    web) jsdom + @testing-library to the core — a core regeneration,
//    tracked separately. Check 4 fails if an entry here becomes
//    unnecessary, so the list cannot rot. ───────────────────────────────
const KNOWN_MISSING_TEST_TARGET = {
  'full-stack-app': ['api', 'web'],
};

// ── The literal verify commands that shipped in 4.0.3. Every one of these
//    must still be rejected by the checks below. ────────────────────────
const SHIPPED_4_0_3 = [
  ['schema', 'pnpm nx test db --testPathPattern={module}'],
  ['contract', 'pnpm nx test contracts --testPathPattern={module}'],
  ['controller', 'pnpm nx test api --testPathPattern={module}'],
  ['hook', 'pnpm nx test hooks --testPathPattern={module}'],
  [
    'screen',
    'pnpm nx test web --testPathPattern={module} && pnpm nx test mobile --testPathPattern={module}',
  ],
  ['join', 'pnpm typecheck && pnpm nx run-many -t test'],
];
const UNANCHORED_FIXTURE = [['hook', 'pnpm nx test hooks -- {module}']];

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Splits a verify command on shell operators into individual commands.
const splitCommands = (verify) =>
  verify
    .split(/&&|\|\||;|(?<!\|)\|(?!\|)/)
    .map((c) => c.trim())
    .filter(Boolean);

// ── Check 1: no Jest-only flag anywhere in a verify command. ───────────
function checkJestFlags(fail, label, verify) {
  for (const flag of JEST_ONLY_FLAGS) {
    if (new RegExp(`--${flag}\\b`).test(verify)) {
      fail(
        `${label}: verify uses Jest-only flag \`--${flag}\` — this core runs Vitest, ` +
          `whose CLI exits with "CACError: Unknown option" before any test runs`,
      );
    }
  }
}

// ── Check 2: every `pnpm <script>` a verify names exists. ──────────────
function checkPnpmScripts(fail, label, verify, pkg) {
  if (!pkg) return;
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  for (const command of splitCommands(verify)) {
    const tokens = command.split(/\s+/);
    if (tokens[0] !== 'pnpm') continue;
    // skip pnpm's own flags (`pnpm --filter x exec ...`)
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) i += 2;
    const name = tokens[i];
    if (!name || PNPM_SUBCOMMANDS.has(name) || deps.has(name)) continue;
    if (!scripts.has(name)) {
      fail(
        `${label}: verify runs \`pnpm ${name}\`, but the core's package.json defines no ` +
          `"${name}" script (has: ${[...scripts].join(', ') || 'none'})`,
      );
    }
  }
}

// ── Check 3: a {module} used as a test filter is path-anchored. ────────
//    A bare `{module}` token is a substring match against the whole test
//    file path; it must carry its layer's directory and a trailing slash.
function checkAnchoredFilter(fail, label, verify) {
  for (const token of verify.split(/\s+/)) {
    if (!token.includes('{module}')) continue;
    if (token === '{module}') {
      fail(
        `${label}: verify passes a bare \`{module}\` as a test filter — Vitest matches it ` +
          `as a substring of the whole file path, so it also selects another module's files ` +
          `(and a module named "list" hits \`vitest list\`, which exits 0 without running ` +
          `anything). Anchor it on the layer's own directory, e.g. \`src/schema/{module}/\``,
      );
    } else if (token.startsWith('{module}/') || (token.includes('/') && !token.endsWith('/'))) {
      fail(
        `${label}: test-filter path \`${token}\` is not anchored on the layer's own directory ` +
          `with a trailing slash`,
      );
    }
  }
}

// ── Check 4: `nx test <project>` names a project with a test target. ───
async function checkNxTestTargets(fail, coreName, coreDir, label, verify) {
  const shipped = new Map(); // project name -> project dir
  for (const group of ['apps', 'packages']) {
    const groupDir = join(coreDir, group);
    if (!(await exists(groupDir))) continue;
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupDir, entry.name, 'package.json');
      if (!(await exists(pkgPath))) continue;
      const { name } = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (name) shipped.set(name, join(groupDir, entry.name));
    }
  }
  const allowed = new Set(KNOWN_MISSING_TEST_TARGET[coreName] ?? []);
  for (const m of verify.matchAll(/\bnx\s+test\s+([A-Za-z0-9@/._-]+)/g)) {
    const project = m[1];
    if (project.includes('{module}')) continue; // per-module project, generated later
    const dir = shipped.get(project);
    if (!dir) continue; // not shipped by the core (add-on or loop-created)
    const hasVitest = (
      await Promise.all(
        ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js'].map(
          (f) => exists(join(dir, f)),
        ),
      )
    ).some(Boolean);
    if (!hasVitest && !allowed.has(project)) {
      fail(
        `${label}: verify runs \`nx test ${project}\`, but the shipped ${project} project has ` +
          `no vitest config, so it has no \`test\` target ("Cannot find configuration for ` +
          `task ${project}:test")`,
      );
    }
    if (hasVitest && allowed.has(project)) {
      fail(
        `KNOWN_MISSING_TEST_TARGET["${coreName}"] still lists "${project}", but that project ` +
          `now ships a vitest config — drop the entry`,
      );
    }
  }
}

// Lints every core.yaml under <root>/src/golden-cores, then re-runs the
// checks against the 4.0.3 fixture to prove they still detect it. Returns
// the failure messages; an empty array means clean.
export async function lintCoreVerifyCommands(root) {
  const coresDir = join(root, 'src/golden-cores');
  const failures = [];
  const fail = (msg) => failures.push(msg);

  const coreNames = (await readdir(coresDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const coreName of coreNames) {
    const coreDir = join(coresDir, coreName);
    const core = parseCoreYaml(await readFile(join(coreDir, 'core.yaml'), 'utf8'));
    validateCore(core);

    const pkgPath = join(coreDir, 'package.json');
    const pkg = (await exists(pkgPath)) ? JSON.parse(await readFile(pkgPath, 'utf8')) : null;

    for (const layer of core.layers) {
      const label = `src/golden-cores/${coreName}/core.yaml layer "${layer.id}"`;
      checkJestFlags(fail, label, layer.verify);
      checkPnpmScripts(fail, label, layer.verify, pkg);
      checkAnchoredFilter(fail, label, layer.verify);
      await checkNxTestTargets(fail, coreName, coreDir, label, layer.verify);
    }
  }

  // ── Regression fixture. Each 4.0.3 string is fed back through the same
  //    checks; detecting it is the pass condition, so the expected
  //    failures are discarded and only a MISSED one is reported. ────────
  const fsaPkgPath = join(coresDir, 'full-stack-app/package.json');
  if (await exists(fsaPkgPath)) {
    const fsaPkg = JSON.parse(await readFile(fsaPkgPath, 'utf8'));
    for (const [layerId, verify] of SHIPPED_4_0_3) {
      const before = failures.length;
      const label = `fixture "${layerId}"`;
      checkJestFlags(fail, label, verify);
      checkPnpmScripts(fail, label, verify, fsaPkg);
      if (failures.length === before) {
        fail(
          `scripts/lint-core-verify.mjs: regression fixture no longer detected — the 4.0.3 ` +
            `${layerId} verify \`${verify}\` now passes every check`,
        );
      } else {
        failures.length = before;
      }
    }
    for (const [layerId, verify] of UNANCHORED_FIXTURE) {
      const before = failures.length;
      checkAnchoredFilter(fail, `fixture "${layerId}"`, verify);
      if (failures.length === before) {
        fail(
          `scripts/lint-core-verify.mjs: regression fixture no longer detected — the ` +
            `unanchored ${layerId} filter \`${verify}\` now passes every check`,
        );
      } else {
        failures.length = before;
      }
    }
  }

  return { failures, coreNames };
}

// ── Standalone entrypoint ─────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { failures, coreNames } = await lintCoreVerifyCommands(root);
  if (failures.length > 0) {
    console.error(`\n${failures.length} verify-command check(s) failed:\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(
    `ok — verify commands lint clean across ${coreNames.length} cores ` +
      `(${coreNames.join(', ')}), and the 4.0.3 regression fixture is still detected`,
  );
}
