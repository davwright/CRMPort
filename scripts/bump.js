#!/usr/bin/env node
/**
 * bump.js — Bump version across all packages from root package.json.
 *
 * Usage:
 *   node scripts/bump.js patch    (0.1.4 → 0.1.5)
 *   node scripts/bump.js minor    (0.1.4 → 0.2.0)
 *   node scripts/bump.js major    (0.1.4 → 1.0.0)
 *
 * Root package.json is the source of truth. Server and SDK are synced.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const level = process.argv[2] || 'patch';
const rootDir = path.join(__dirname, '..');

function readPkg(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function writePkg(p, pkg) { fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n'); }

const rootPkgPath = path.join(rootDir, 'package.json');
const rootPkg = readPkg(rootPkgPath);
const parts = rootPkg.version.split('.').map(Number);

switch (level) {
  case 'major':
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
    break;
  case 'minor':
    parts[1]++;
    parts[2] = 0;
    break;
  case 'patch':
    parts[2]++;
    break;
  default:
    throw new Error(`Unknown level: ${level}. Use major, minor, or patch.`);
}

const newVersion = parts.join('.');
console.log(`${rootPkg.version} → ${newVersion} (${level})`);

// Update root
rootPkg.version = newVersion;
writePkg(rootPkgPath, rootPkg);

// Sync server
const serverPkgPath = path.join(rootDir, 'packages', 'server', 'package.json');
const serverPkg = readPkg(serverPkgPath);
serverPkg.version = newVersion;
writePkg(serverPkgPath, serverPkg);

// Sync SDK
const sdkPkgPath = path.join(rootDir, 'packages', 'sdk', 'package.json');
const sdkPkg = readPkg(sdkPkgPath);
sdkPkg.version = newVersion;
writePkg(sdkPkgPath, sdkPkg);

console.log(`v${newVersion}`);
