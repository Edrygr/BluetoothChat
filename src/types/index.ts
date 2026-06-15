export type MessageType =
  | 'HANDSHAKE'
  | 'GENERAL'
  | 'DM'
  | 'MEDIA_START'
  | 'MEDIA_CHUNK'
  | 'MEDIA_END'
  | 'COVER'       // encrypted dummy packet for traffic analysis resistance
  | 'DISCONNECT';

export type MediaKind = 'image' | 'video';

export interface BTPacket {
  type: MessageType;
  id: string;
  from: string;          // anonymousId — omitted from relayed packets (minimal metadata)
  to?: string;           // recipient anonymousId (DM only)
  data?: string;         // AES-GCM ciphertext (base64)
  nonce?: string;        // AES-GCM nonce (base64)
  seqNum?: number;       // ratchet sequence number (replay prevention)
  // Handshake
  publicKey?: string;    // hex-encoded X25519 public key
  anonymousId?: string;
  // Media
  mediaId?: string;
  mediaKind?: MediaKind;
  chunkIndex?: number;
  totalChunks?: number;
  mimeType?: string;
}

export interface Peer {
  deviceId: string;      // BT MAC address
  anonymousId: string;
  publicKeyHex: string;  // hex X25519 public key
  sas: string;           // Short Authentication String e.g. "4F-2A-9C"
  connected: boolean;
}

export type ChatMessageKind = 'text' | MediaKind;

export interface ChatMessage {
  id: string;
  fromId: string;
  fromSelf: boolean;
  content: string;
  kind: ChatMessageKind;
  localUri?: string;
  mediaKind?: MediaKind;
  timestamp: number;
  isDM: boolean;
  peerId?: string;
  expiresAt?: number;    // epoch ms — undefined = never expires
}

/** Plaintext payload encoded inside the AES-GCM ciphertext */
export interface MessagePayload {
  text: string;
  ttl?: number;          // self-destruct seconds (0 = no expiry)
}
