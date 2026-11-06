#!/usr/bin/env node
/**
 * Builds the plugin, writes a uniquely named tarball, and optionally installs it into a Strapi
 * project in one step.
 *
 *   npm run pack:local
 *   npm run pack:local -- --install "D:\path\to\strapi-project"
 *   npm run pack:local -- --install "D:\path\to\strapi-project" --skip-build
 *
 * With no `--install` it just prints the tarball path and the commands to run by hand. The
 * target can also come from `AUDIT_LOG_INSTALL_TARGET`, so a repeat install is a bare `npm run
 * pack:local`.
 *
 * The unique filename is the point. Both npm and yarn cache a `file:` tarball under its package
 * name and version, so installing a rebuilt `strapi-plugin-cms-audit-log-0.1.0.tgz` over the top
 * of itself does one of three unhelpful things:
 *
 *   - reports success and silently installs the previously cached copy,
 *   - fails with `error Integrity check failed` once the lockfile hash no longer matches,
 *   - or, with yarn, does either of those depending on the state of its cache.
 *
 * A filename that has never been seen before sidesteps all of it: new resolution, new lockfile
 * entry, no cache hit. Verified against yarn 1.22 and npm 10.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : (argv[index + 1] ?? '');
};
const has = (name) => argv.includes(`--${name}`);

const target = flag('install') || process.env.AUDIT_LOG_INSTALL_TARGET || '';
const skipBuild = has('skip-build');

const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

const capture = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

/** Relative path -> sha256, for every file under a `dist` directory. */
function manifestOf(distDir) {
  const entries = new Map();

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(distDir, full).split(path.sep).join('/');
      entries.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };

  if (existsSync(distDir)) walk(distDir);

  return entries;
}

function compareManifests(expected, actual) {
  const missing = [...expected.keys()].filter((file) => !actual.has(file));
  const different = [...expected.entries()]
    .filter(([file, hash]) => actual.has(file) && actual.get(file) !== hash)
    .map(([file]) => file);

  return { missing, different, ok: missing.length === 0 && different.length === 0 };
}

console.log('Building…');
run('npx', ['strapi-plugin', 'build']);

const staging = path.join(os.tmpdir(), 'strapi-plugin-cms-audit-log-packs');
mkdirSync(staging, { recursive: true });

console.log('Packing…');
const packOutput = capture('npm', ['pack', '--json', '--pack-destination', staging]);
const packed = JSON.parse(packOutput.slice(packOutput.indexOf('[')))[0].filename;
const packedPath = path.join(staging, packed);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const uniqueName = `${pkg.name}-${pkg.version}-${stamp}.tgz`;
const uniquePath = path.join(staging, uniqueName);

copyFileSync(packedPath, uniquePath);
rmSync(packedPath, { force: true });

console.log('');
console.log(`Built ${pkg.name}@${pkg.version}`);
console.log(uniquePath);
console.log('');

if (!target) {
  console.log('Install it into your Strapi project with one of:');
  console.log('');
  console.log(`  yarn add "file:${uniquePath}"`);
  console.log(`  npm install "${uniquePath}"`);
  console.log('');
  console.log('Then clear node_modules\\.strapi\\vite, run the project build, restart Strapi and');
  console.log('hard-refresh the browser (Ctrl+Shift+R).');
  console.log('');
  console.log('Or let this script do all of it:');
  console.log('');
  console.log('  npm run pack:local -- --install "D:\\path\\to\\strapi-project"');
  process.exit(0);
}

// Resolved against the caller's working directory, so `--install .` works when the script is
// invoked by path from inside the target project.
const project = path.resolve(process.cwd(), target);

if (!existsSync(path.join(project, 'package.json'))) {
  console.error(`No package.json in ${project}. Point --install at a Strapi project root.`);
  process.exit(1);
}

if (project === root) {
  console.error('--install points at the plugin repository itself. Point it at a Strapi project.');
  process.exit(1);
}

const projectPkg = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
const manager = existsSync(path.join(project, 'yarn.lock'))
  ? 'yarn'
  : existsSync(path.join(project, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : 'npm';

console.log(`Installing into ${project} with ${manager}…`);

if (manager === 'npm') {
  run('npm', ['install', uniquePath], project);
} else {
  run(manager, ['add', `file:${uniquePath}`], project);
}

// Vite pre-bundles the admin dependencies and keys the cache on resolved paths, so a replaced
// plugin can otherwise keep serving the previous chunk.
for (const cache of [path.join(project, 'node_modules', '.strapi', 'vite'), path.join(project, '.strapi', 'client')]) {
  if (existsSync(cache)) {
    console.log(`Clearing ${path.relative(project, cache)}…`);
    rmSync(cache, { recursive: true, force: true });
  }
}

if (skipBuild) {
  console.log('Skipping the project build (--skip-build).');
} else if (projectPkg.scripts?.build) {
  console.log('Building the admin panel… this takes a minute.');
  run(manager, manager === 'npm' ? ['run', 'build'] : ['build'], project);
} else {
  console.log('No build script in the target project, skipping the admin build.');
}

const installed = manifestOf(path.join(project, 'node_modules', pkg.name, 'dist'));
const comparison = compareManifests(manifestOf(path.join(root, 'dist')), installed);

console.log('');

if (!comparison.ok) {
  console.error('The installed copy does not match this build.');
  if (comparison.missing.length > 0) console.error(`  missing  : ${comparison.missing.join(', ')}`);
  if (comparison.different.length > 0) console.error(`  stale    : ${comparison.different.join(', ')}`);
  console.error('');
  console.error('This is almost always a package manager cache hit. Remove the dependency from the');
  console.error('target package.json and lockfile, then run this script again.');
  process.exit(1);
}

console.log(`Verified: all ${installed.size} files in dist match this build byte for byte.`);
console.log('');
console.log('Restart Strapi and hard-refresh the browser (Ctrl+Shift+R).');
