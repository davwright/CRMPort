import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// --- Ed25519 Code Signing ---

export interface KeyPair {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

export function exportPublicKey(key: crypto.KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

export function exportPrivateKey(key: crypto.KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function loadPublicKey(pem: string): crypto.KeyObject {
  return crypto.createPublicKey(pem);
}

export function loadPrivateKey(pem: string): crypto.KeyObject {
  return crypto.createPrivateKey(pem);
}

export function signContent(content: Buffer, privateKey: crypto.KeyObject): string {
  const signature = crypto.sign(null, content, privateKey);
  return signature.toString('base64');
}

export function verifySignature(content: Buffer, signature: string, publicKey: crypto.KeyObject): boolean {
  try {
    return crypto.verify(null, content, publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function signFile(filePath: string, privateKey: crypto.KeyObject): void {
  const content = fs.readFileSync(filePath);
  const sig = signContent(content, privateKey);
  fs.writeFileSync(`${filePath}.sig`, sig, 'utf8');
}

export function verifyFile(filePath: string, publicKey: crypto.KeyObject): boolean {
  const content = fs.readFileSync(filePath);
  const sigPath = `${filePath}.sig`;
  if (!fs.existsSync(sigPath)) return false;
  const sig = fs.readFileSync(sigPath, 'utf8').trim();
  return verifySignature(content, sig, publicKey);
}

// --- Capability Tokens (JWT-like with Ed25519) ---

export interface CapabilityClaims {
  sub: string;        // plugin id
  iss: string;        // "crmport"
  iat: number;        // issued at (unix seconds)
  exp: number;        // expires at (unix seconds)
  cap: {
    allow: string[];  // e.g. ["fs.read:C:/Projects/**", "exec:git"]
    deny: string[];   // e.g. ["fs.read:**/.env"]
  };
  limits: {
    max_requests_per_minute: number;
    max_file_size_bytes: number;
    max_exec_timeout_ms: number;
  };
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export function issueCapabilityToken(claims: CapabilityClaims, privateKey: crypto.KeyObject): string {
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const sigInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(sigInput), privateKey);
  return `${sigInput}.${base64url(signature)}`;
}

export function verifyCapabilityToken(token: string, publicKey: crypto.KeyObject): CapabilityClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, sig] = parts;
  const sigInput = `${header}.${payload}`;

  try {
    const valid = crypto.verify(null, Buffer.from(sigInput), publicKey, Buffer.from(sig, 'base64url'));
    if (!valid) return null;

    const claims: CapabilityClaims = JSON.parse(base64urlDecode(payload));
    if (claims.exp < Date.now() / 1000) return null;

    return claims;
  } catch {
    return null;
  }
}

// --- Capability Matching ---

function matchGlob(pattern: string, value: string): boolean {
  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  const re = new RegExp(`^${escaped}$`, 'i');
  return re.test(value);
}

export function checkCapability(claims: CapabilityClaims, capability: string, resource?: string): boolean {
  // Check deny first
  for (const deny of claims.cap.deny) {
    const [denyCap, denyResource] = splitCapability(deny);
    if (denyCap === capability && (!denyResource || !resource || matchGlob(denyResource, resource))) {
      return false;
    }
  }

  // Check allow
  for (const allow of claims.cap.allow) {
    const [allowCap, allowResource] = splitCapability(allow);
    if (allowCap === capability) {
      if (!allowResource && !resource) return true;
      if (allowResource && resource && matchGlob(allowResource, resource)) return true;
      if (!allowResource) return true;
    }
  }

  return false;
}

function splitCapability(cap: string): [string, string | undefined] {
  const idx = cap.indexOf(':');
  if (idx === -1) return [cap, undefined];
  return [cap.substring(0, idx), cap.substring(idx + 1)];
}

// --- HMAC Challenge-Response ---

export function createChallenge(): { nonce: string; timestamp: number } {
  return {
    nonce: crypto.randomBytes(32).toString('hex'),
    timestamp: Date.now(),
  };
}

export function signChallenge(nonce: string, payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(nonce + payload).digest('hex');
}

export function verifyChallenge(nonce: string, payload: string, signature: string, secret: string): boolean {
  const expected = signChallenge(nonce, payload, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// --- Token generation for registration ---

export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function getPublicKeyFingerprint(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(der).digest('base64');
  return `SHA256:${hash}`;
}
