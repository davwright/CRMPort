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

const installerName = `CRMPort-${version}-setup`;
const assetName = `${installerName}.zip`;
const assetPath = path.join(distDir, assetName);

// Stage everything into a temp directory for zipping
const stageDir = path.join(distDir, 'stage');
if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true });
fs.mkdirSync(stageDir, { recursive: true });

// Copy built server (exclude sourcemaps)
execSync(`xcopy /s /y /q "${serverDist}\\*" "${stageDir}\\"`, { stdio: 'inherit' });
for (const f of fs.readdirSync(stageDir)) {
  if (f.endsWith('.map')) fs.unlinkSync(path.join(stageDir, f));
}

// Copy config-ui
const configUiSrc = path.join(rootDir, 'packages', 'server', 'config-ui');
const configUiDst = path.join(stageDir, 'config-ui');
fs.mkdirSync(configUiDst, { recursive: true });
execSync(`xcopy /s /y /q "${configUiSrc}\\*" "${configUiDst}\\"`, { stdio: 'inherit' });

// Copy assets (icon)
const assetsSrc = path.join(rootDir, 'packages', 'server', 'assets');
if (fs.existsSync(assetsSrc)) {
  const assetsDst = path.join(stageDir, 'assets');
  fs.mkdirSync(assetsDst, { recursive: true });
  execSync(`xcopy /s /y /q "${assetsSrc}\\*" "${assetsDst}\\"`, { stdio: 'inherit' });
}

// Copy package.json for version info
fs.copyFileSync(
  path.join(rootDir, 'packages', 'server', 'package.json'),
  path.join(stageDir, 'package.json'),
);

// Copy only external deps (systray2) — everything else is bundled by esbuild
// Only include the current platform's tray binary to save ~7MB
const systrayDir = path.join(rootDir, 'node_modules', 'systray2');
if (fs.existsSync(systrayDir)) {
  const dst = path.join(stageDir, 'node_modules', 'systray2');
  fs.mkdirSync(path.join(stageDir, 'node_modules'), { recursive: true });
  execSync(`xcopy /s /y /q "${systrayDir}\\*" "${dst}\\"`, { stdio: 'inherit' });

  // Remove other platform binaries
  const trayBinDir = path.join(dst, 'traybin');
  if (fs.existsSync(trayBinDir)) {
    const keep = process.platform === 'win32' ? 'tray_windows_release.exe'
               : process.platform === 'darwin' ? 'tray_darwin_release'
               : 'tray_linux_release';
    for (const f of fs.readdirSync(trayBinDir)) {
      if (f !== keep) fs.unlinkSync(path.join(trayBinDir, f));
    }
  }
}

// Copy install/uninstall scripts
fs.copyFileSync(path.join(rootDir, 'scripts', 'install.bat'), path.join(stageDir, 'install.bat'));
fs.copyFileSync(path.join(rootDir, 'scripts', 'uninstall.bat'), path.join(stageDir, 'uninstall.bat'));

// Zip it
console.log(`Creating ${assetName}...`);
if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
execSync(`powershell -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${assetPath}'"`, {
  stdio: 'inherit',
});

// Clean up stage
fs.rmSync(stageDir, { recursive: true });

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
