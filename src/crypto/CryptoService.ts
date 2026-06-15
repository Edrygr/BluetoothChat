/**
 * Cryptographic primitives:
 *
 *   Key exchange  — X25519 (Curve25519 Diffie-Hellman, ephemeral per session)
 *   Encryption    — AES-256-GCM (authenticated — ciphertext integrity verified)
 *   Ratchet       — Symmetric ratchet (HMAC-SHA256 chain, per-message one-time keys)
 *   SAS           — Short Authentication String for out-of-band MitM verification
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — noble packages use .js subpath exports
import { x25519 } from '@noble/curves/ed25519.js';
// @ts-ignore
import { gcm } from '@noble/ciphers/aes.js';
// @ts-ignore
import { randomBytes } from '@noble/ciphers/utils.js';
// @ts-ignore
import { hmac } from '@noble/hashes/hmac.js';
// @ts-ignore — sha256 lives in sha2.js, not sha256.js
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Key pair (X25519) ────────────────────────────────────────────────────────

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey  = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ─── ECDH shared secret ───────────────────────────────────────────────────────

export function deriveSharedSecret(myPrivateKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, theirPublicKey);
}

// ─── SAS (Short Authentication String, 3 bytes = 6 hex chars) ────────────────

/**
 * Both peers see the same string and compare it verbally.
 * A match means there is no man-in-the-middle.
 */
export function deriveSAS(sharedSecret: Uint8Array): string {
  const hash = sha256(sharedSecret);
  return Array.from(hash.slice(0, 3) as Uint8Array)
    .map((b: number) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('-');
}

// ─── Symmetric ratchet (HMAC-SHA256 chain) ────────────────────────────────────

export interface RatchetState {
  chainKey: Uint8Array;
  sendSeq: number;
  recvSeq: number;
}

const MSG_KEY_LABEL   = new Uint8Array([0x01]);
const CHAIN_KEY_LABEL = new Uint8Array([0x02]);

export function initRatchet(sharedSecret: Uint8Array): RatchetState {
  return { chainKey: sharedSecret.slice(), sendSeq: 0, recvSeq: 0 };
}

export function ratchetSend(state: RatchetState): { messageKey: Uint8Array; seqNum: number } {
  const messageKey = hmac(sha256, state.chainKey, MSG_KEY_LABEL);
  state.chainKey   = hmac(sha256, state.chainKey, CHAIN_KEY_LABEL);
  return { messageKey, seqNum: state.sendSeq++ };
}

/**
 * Returns null if seqNum is wrong (replay or reorder) — caller must drop the packet.
 */
export function ratchetRecv(state: RatchetState, seqNum: number): Uint8Array | null {
  if (seqNum !== state.recvSeq) return null;
  const messageKey = hmac(sha256, state.chainKey, MSG_KEY_LABEL);
  state.chainKey   = hmac(sha256, state.chainKey, CHAIN_KEY_LABEL);
  state.recvSeq++;
  return messageKey;
}

// ─── AES-256-GCM ─────────────────────────────────────────────────────────────

export interface Encrypted {
  data: string;   // base64 ciphertext + GCM auth tag
  nonce: string;  // base64 12-byte nonce
}

export function encrypt(plaintext: string, key: Uint8Array): Encrypted {
  const nonce      = randomBytes(12);
  const cipher     = gcm(key, nonce);
  const bytes      = strToBytes(plaintext);
  const ciphertext = cipher.encrypt(bytes);
  return { data: bytesToBase64(ciphertext), nonce: bytesToBase64(nonce) };
}

export function decrypt(enc: Encrypted, key: Uint8Array): string {
  const nonce      = base64ToBytes(enc.nonce);
  const ciphertext = base64ToBytes(enc.data);
  const decipher   = gcm(key, nonce);
  // gcm.decrypt throws if the GCM authentication tag is invalid
  const bytes = decipher.decrypt(ciphertext);
  return bytesToStr(bytes);
}

// ─── Encode helpers ───────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function strToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(++i);
      if (lo >= 0xdc00 && lo <= 0xdfff) cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
    }
    if (cp < 0x80)         { out.push(cp); }
    else if (cp < 0x800)   { out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
    else if (cp < 0x10000) { out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
    else                   { out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
  }
  return new Uint8Array(out);
}

function bytesToStr(b: Uint8Array): string {
  let r = '';
  let i = 0;
  while (i < b.length) {
    const byte1 = b[i++];
    let cp: number;
    if (byte1 < 0x80)             { cp = byte1; }
    else if ((byte1 & 0xe0) === 0xc0) { cp = ((byte1 & 0x1f) << 6)  | (b[i++] & 0x3f); }
    else if ((byte1 & 0xf0) === 0xe0) { cp = ((byte1 & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f); }
    else { cp = ((byte1 & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
           cp -= 0x10000; r += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); continue; }
    r += String.fromCharCode(cp);
  }
  return r;
}
