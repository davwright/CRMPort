#!/usr/bin/env node
/**
 * release.js — Build installer and create a GitHub release.
 *
 * Usage: npm run release
 *
 * 1. Reads version from packages/server/package.json
 * 2. Creates the MSI installer (placeholder — replace with actual WiX/NSIS build)
 * 3. Signs the binary with the code-signing key
 * 4. Creates a GitHub release tagged v{version}
 * 5. Uploads the installer as a release asset
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'server', 'package.json'), 'utf-8')
);
const version = serverPkg.version;
const tag = `v${version}`;
const distDir = path.join(__dirname, '..', 'dist');

console.log(`Releasing CRMPort ${tag}`);

// Ensure dist directory
fs.mkdirSync(distDir, { recursive: true });

// Build the server binary (placeholder — in production this would be pkg/nexe/sea)
const serverDist = path.join(__dirname, '..', 'packages', 'server', 'dist');
if (!fs.existsSync(path.join(serverDist, 'main.js'))) {
  throw new Error('Server not built — run npm run build first');
}

// Create installer package name
const platform = process.platform === 'win32' ? 'setup.msi' : process.platform === 'darwin' ? '.pkg' : '.deb';
const installerName = `CRMPort-${version}-${platform}`;
const installerPath = path.join(distDir, installerName);

// Placeholder: create a zip of the dist as the "installer"
// In production, replace this with WiX (MSI), pkgbuild (macOS), or dpkg-deb (Linux)
console.log(`Creating ${installerName}...`);
execSync(`tar -czf "${installerPath}.tar.gz" -C "${serverDist}" .`, { stdio: 'inherit' });
const assetPath = `${installerPath}.tar.gz`;
const assetName = `${installerName}.tar.gz`;

// Sign if code-signing key exists
const keysDir = path.join(require('os').homedir(), '.crmport', 'keys');
const codeSignKeyPath = path.join(keysDir, 'codesign.key');
if (fs.existsSync(codeSignKeyPath)) {
  console.log('Signing release artifact...');
  execSync(`npx tsx packages/server/src/tools/keygen.ts sign "${assetPath}"`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
}

// Sync root package.json version
const rootPkgPath = path.join(__dirname, '..', 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
rootPkg.version = version;
fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');

// Git tag
try {
  execSync(`git tag ${tag}`, { stdio: 'inherit' });
} catch {
  console.log(`Tag ${tag} already exists, skipping`);
}

// Push tag
execSync(`git push origin ${tag}`, { stdio: 'inherit' });

// Create GitHub release with asset
console.log(`Creating GitHub release ${tag}...`);
const releaseArgs = [
  `gh release create ${tag}`,
  `--title "CRMPort ${tag}"`,
  `--notes "CRMPort ${tag} release"`,
  `"${assetPath}#${assetName}"`,
];

// Upload .sig file if it exists
const sigPath = `${assetPath}.sig`;
if (fs.existsSync(sigPath)) {
  releaseArgs.push(`"${sigPath}#${assetName}.sig"`);
}

execSync(releaseArgs.join(' '), { stdio: 'inherit' });

console.log(`\nReleased CRMPort ${tag}`);
console.log(`  https://github.com/davwright/CRMPort/releases/tag/${tag}`);
