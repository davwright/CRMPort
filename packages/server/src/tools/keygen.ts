#!/usr/bin/env tsx
/**
 * Key generation tool for CRMPort.
 *
 * Usage:
 *   npx tsx src/tools/keygen.ts              # Generate both keypairs
 *   npx tsx src/tools/keygen.ts codesign     # Generate code-signing keypair only
 *   npx tsx src/tools/keygen.ts capability   # Generate capability keypair only
 *   npx tsx src/tools/keygen.ts sign <file>  # Sign a file with the code-signing key
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config.js';

const config = loadConfig();

function generateAndSave(name: string): void {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const pubPath = path.join(config.keysDir, `${name}.pub`);
  const privPath = path.join(config.keysDir, `${name}.key`);

  fs.writeFileSync(pubPath, pubPem);
  fs.writeFileSync(privPath, privPem);

  const fingerprint = crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');

  console.log(`Generated ${name} keypair:`);
  console.log(`  Public:  ${pubPath}`);
  console.log(`  Private: ${privPath}`);
  console.log(`  Fingerprint: SHA256:${fingerprint}`);
  console.log();
}

function signFile(filePath: string): void {
  const privPath = path.join(config.keysDir, 'codesign.key');
  if (!fs.existsSync(privPath)) {
    console.error('Code-signing private key not found. Run: npx tsx src/tools/keygen.ts codesign');
    process.exit(1);
  }

  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'));
  const content = fs.readFileSync(filePath);
  const signature = crypto.sign(null, content, privateKey);
  const sigPath = `${filePath}.sig`;
  fs.writeFileSync(sigPath, signature.toString('base64'), 'utf8');

  console.log(`Signed: ${filePath}`);
  console.log(`Signature: ${sigPath}`);
}

const command = process.argv[2];

switch (command) {
  case 'codesign':
    generateAndSave('codesign');
    break;
  case 'capability':
    generateAndSave('capability');
    break;
  case 'sign':
    if (!process.argv[3]) {
      console.error('Usage: keygen.ts sign <file>');
      process.exit(1);
    }
    signFile(process.argv[3]);
    break;
  default:
    generateAndSave('codesign');
    generateAndSave('capability');
    console.log('Both keypairs generated. Keep codesign.key on your build machine only!');
    break;
}
