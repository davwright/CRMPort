#!/usr/bin/env node
/**
 * release.js — Commit version bump, build, create GitHub release.
 *
 * Called by: npm run release
 * By the time this runs, bump.js has already run (minor bump) and build has completed.
 *
 * Steps:
 * 1. Commit package.json + package-lock.json (version bump)
 * 2. Create installer artifact
 * 3. Sign if code-signing key exists
 * 4. Tag, push, create GitHub release with asset
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
const version = rootPkg.version;
const tag = `v${version}`;

console.log(`\nReleasing CRMPort ${tag}\n`);

// ── Step 1: Commit the version bump ─────────────────────────────────

execSync('git add package.json package-lock.json packages/server/package.json packages/sdk/package.json', {
  cwd: rootDir,
  stdio: 'inherit',
});
execSync(`git commit -m "v${version}"`, {
  cwd: rootDir,
  stdio: 'inherit',
});
console.log(`Committed v${version}`);

// ── Step 2: Create installer artifact ───────────────────────────────

const distDir = path.join(rootDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const serverDist = path.join(rootDir, 'packages', 'server', 'dist');
if (!fs.existsSync(path.join(serverDist, 'main.js'))) {
  throw new Error('Server not built — build step failed');
}

const platformExt = process.platform === 'win32' ? 'setup.msi' : process.platform === 'darwin' ? '.pkg' : '.deb';
const installerName = `CRMPort-${version}-${platformExt}`;
const installerPath = path.join(distDir, installerName);

// Placeholder: tar.gz of dist (replace with WiX/pkgbuild/dpkg-deb in production)
console.log(`Creating ${installerName}.tar.gz...`);
execSync(`tar -czf "${installerPath}.tar.gz" -C "${serverDist}" .`, { stdio: 'inherit' });
const assetPath = `${installerPath}.tar.gz`;
const assetName = `${installerName}.tar.gz`;

// ── Step 3: Sign ────────────────────────────────────────────────────

const keysDir = path.join(require('os').homedir(), '.crmport', 'keys');
const codeSignKeyPath = path.join(keysDir, 'codesign.key');
if (fs.existsSync(codeSignKeyPath)) {
  console.log('Signing release artifact...');
  execSync(`npx tsx packages/server/src/tools/keygen.ts sign "${assetPath}"`, {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

// ── Step 4: Tag + push + GitHub release ─────────────────────────────

execSync(`git tag ${tag}`, { cwd: rootDir, stdio: 'inherit' });
execSync(`git push origin main ${tag}`, { cwd: rootDir, stdio: 'inherit' });
console.log(`Pushed ${tag}`);

// Generate release notes from commits since last tag
let notes;
try {
  const lastTag = execSync('git describe --tags --abbrev=0 HEAD~1', { cwd: rootDir, encoding: 'utf-8' }).trim();
  const log = execSync(`git log ${lastTag}..HEAD~1 --pretty=format:"- %s" --no-merges`, { cwd: rootDir, encoding: 'utf-8' }).trim();
  notes = log || `CRMPort ${tag}`;
} catch {
  // No previous tag — include all commits
  const log = execSync('git log --pretty=format:"- %s" --no-merges -20', { cwd: rootDir, encoding: 'utf-8' }).trim();
  notes = log || `CRMPort ${tag}`;
}

const releaseCmd = [
  `gh release create ${tag}`,
  `--title "CRMPort ${tag}"`,
  `--notes "${notes.replace(/"/g, '\\"')}"`,
  `"${assetPath}#${assetName}"`,
];

const sigPath = `${assetPath}.sig`;
if (fs.existsSync(sigPath)) {
  releaseCmd.push(`"${sigPath}#${assetName}.sig"`);
}

execSync(releaseCmd.join(' '), { cwd: rootDir, stdio: 'inherit' });

console.log(`\nReleased CRMPort ${tag}`);
console.log(`https://github.com/davwright/CRMPort/releases/tag/${tag}`);
