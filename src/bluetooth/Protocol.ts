/**
 * Serialization/deserialization of BT packets.
 * Packets are newline-delimited JSON strings.
 */
import { BTPacket } from '../types';

const DELIMITER = '\n';
const CHUNK_SIZE = 180; // BLE MTU-safe media chunk size

export function encodePacket(packet: BTPacket): string {
  return JSON.stringify(packet) + DELIMITER;
}

export function decodePackets(raw: string): BTPacket[] {
  return raw
    .split(DELIMITER)
    .filter(s => s.trim().length > 0)
    .map(s => {
      try {
        return JSON.parse(s) as BTPacket;
      } catch {
        return null;
      }
    })
    .filter((p): p is BTPacket => p !== null);
}

export function splitBase64IntoChunks(base64: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}
