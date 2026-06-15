/**
 * BLE mesh service — no pairing required.
 *
 * Each device acts as both:
 *   PERIPHERAL — GATT server + BLE advertising (via native BlePeripheralModule)
 *   CENTRAL    — BLE scanner + GATT client (via react-native-ble-plx)
 *
 * Security layers:
 *   X25519 ECDH key exchange · AES-256-GCM · symmetric ratchet (forward secrecy)
 *   sequence numbers (replay prevention) · cover traffic · panic wipe
 *
 * BLE framing: each JSON packet is split into 490-char frames with a 6-char
 * hex header [seqId(2)][chunkIdx(2)][totalChunks(2)] before transmission, then
 * reassembled on the receiver side.
 */
import { BleManager, Device, State } from 'react-native-ble-plx';
import {
  PermissionsAndroid,
  Platform,
  AppState,
  AppStateStatus,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import { BTPacket, MediaKind, Peer } from '../types';
import { splitBase64IntoChunks } from './Protocol';
import {
  generateKeyPair,
  deriveSharedSecret,
  deriveSAS,
  initRatchet,
  ratchetSend,
  ratchetRecv,
  encrypt,
  decrypt,
  toHex,
  fromHex,
  KeyPair,
  RatchetState,
} from '../crypto/CryptoService';
import { generateAnonymousId, generateMessageId } from '../utils/identity';

export type IncomingMessageCallback = (packet: BTPacket, fromDeviceId: string) => void;
export type PeerChangeCallback     = (peers: Peer[]) => void;

// Base64 ↔ UTF-8 using only btoa/atob + encodeURIComponent/decodeURIComponent
// (no TextEncoder/TextDecoder — not available in all Hermes versions)
function utf8ToBase64(str: string): string {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );
}

function base64ToUtf8(b64: string): string {
  return decodeURIComponent(
    atob(b64)
      .split('')
      .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join(''),
  );
}

// Custom UUIDs for this app
const SERVICE_UUID = 'A1234567-89AB-CDEF-0123-456789ABCDEF';
const TX_UUID      = 'A1234568-89AB-CDEF-0123-456789ABCDEF'; // central writes → peripheral receives
const RX_UUID      = 'A1234569-89AB-CDEF-0123-456789ABCDEF'; // peripheral notifies → central receives

const SCAN_INTERVAL_MS       = 12_000;
const SCAN_DURATION_MS       = 8_000;
const COVER_INTERVAL_MIN_MS  = 6_000;
const COVER_INTERVAL_MAX_MS  = 14_000;
const SEEN_TTL_MS            = 60_000;
const MTU                    = 512;
const FRAME_PAYLOAD          = 490; // chars of JSON per BLE frame
const MESH_TTL               = 5;   // max relay hops

// Prefix for virtual (multi-hop) peer keys in the peers / ratchets maps
const VIRT = 'virtual:';

// ─── BLE framing ─────────────────────────────────────────────────────────────

let frameSeqCounter = 0;
function nextSeq(): number { return (frameSeqCounter = (frameSeqCounter + 1) & 0xff); }

function buildFrames(json: string, seq: number): string[] {
  const total  = Math.max(1, Math.ceil(json.length / FRAME_PAYLOAD));
  const seqH   = seq.toString(16).padStart(2, '0');
  const totalH = total.toString(16).padStart(2, '0');
  const frames: string[] = [];
  for (let i = 0; i < total; i++) {
    const idxH  = i.toString(16).padStart(2, '0');
    const chunk = json.slice(i * FRAME_PAYLOAD, (i + 1) * FRAME_PAYLOAD);
    frames.push(`${seqH}${idxH}${totalH}${chunk}`);
  }
  return frames;
}

function parseFrameHeader(raw: string): { seq: number; idx: number; total: number; data: string } | null {
  if (raw.length < 6) return null;
  return {
    seq:   parseInt(raw.slice(0, 2), 16),
    idx:   parseInt(raw.slice(2, 4), 16),
    total: parseInt(raw.slice(4, 6), 16),
    data:  raw.slice(6),
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

type ReassemblyBuf = { chunks: (string | undefined)[]; total: number };

class BluetoothService {
  private ble = new BleManager();
  private keyPair: KeyPair | null = null;
  public  anonymousId = '';

  // Connections where WE are the central (we connected out)
  private centralConns   = new Map<string, Device>();
  // Connections where WE are the peripheral (they connected to us) — value = true
  private peripheralConns = new Map<string, boolean>();

  private peers         = new Map<string, Peer>();
  private sendRatchets  = new Map<string, RatchetState>();
  private recvRatchets  = new Map<string, RatchetState>();
  private seenIds       = new Map<string, number>();
  private pendingMedia  = new Map<string, Map<string, string[]>>();

  // Mesh routing: for virtual peers (multi-hop), maps peerKey → BLE deviceId of next hop
  private virtualRoutes  = new Map<string, string>();
  // O(1) anonymousId → peerKey lookup (direct: peerKey=deviceId, virtual: peerKey='virtual:'+anon)
  private anonToPeerKey  = new Map<string, string>();

  // Per-device reassembly buffer: deviceId → Map<seqId, ReassemblyBuf>
  private reassembly = new Map<string, Map<number, ReassemblyBuf>>();

  // Per-device write queue (serialise BLE writes)
  private writeQueues = new Map<string, Promise<void>>();

  private onMessage:     IncomingMessageCallback | null = null;
  private onPeersChange: PeerChangeCallback | null      = null;

  private scanTimer:        ReturnType<typeof setInterval> | null = null;
  private seenCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private coverTimer:       ReturnType<typeof setTimeout>  | null = null;
  private appStateSub: any = null;
  private peripheralSubs: any[] = [];
  private scanning = false;
  private destroyed = false;

  // ─── Init ────────────────────────────────────────────────────────────────

  async init(
    onMessage: IncomingMessageCallback,
    onPeersChange: PeerChangeCallback,
  ): Promise<void> {
    this.keyPair      = generateKeyPair();
    this.anonymousId  = generateAnonymousId();
    this.onMessage    = onMessage;
    this.onPeersChange = onPeersChange;

    await this.requestPermissions();

    await new Promise<void>(resolve => {
      const sub = this.ble.onStateChange(state => {
        if (state === State.PoweredOn) { sub.remove(); resolve(); }
      }, true);
    });

    await this.startPeripheral();
    this.startScanLoop();
    this.scheduleCoverTraffic();

    this.seenCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - SEEN_TTL_MS;
      for (const [id, ts] of this.seenIds) if (ts < cutoff) this.seenIds.delete(id);
    }, SEEN_TTL_MS);

    this.appStateSub = AppState.addEventListener('change', this.handleAppState);
  }

  private handleAppState = (s: AppStateStatus) => {
    if (s === 'background' || s === 'inactive') this.destroy();
  };

  private async requestPermissions(): Promise<void> {
    if (Platform.OS !== 'android') return;
    const rel = parseInt(Platform.constants.Release ?? '10', 10);
    if (rel >= 12) {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
      ]);
    } else {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      ]);
    }
  }

  // ─── Peripheral role (native module) ─────────────────────────────────────

  private async startPeripheral(): Promise<void> {
    const { BlePeripheral } = NativeModules;
    if (!BlePeripheral) return;

    const emitter = new NativeEventEmitter(BlePeripheral);

    this.peripheralSubs.push(
      emitter.addListener('BlePeripheralCentralConnected', (address: string) => {
        this.peripheralConns.set(address, true);
        // Send our handshake immediately so the central can register us as a peer
        this.sendHandshake(address);
      }),
      emitter.addListener('BlePeripheralCentralDisconnected', (address: string) => {
        this.peripheralConns.delete(address);
        this.dropPeersByLink(address);
      }),
      emitter.addListener('BlePeripheralDataReceived', (evt: { address: string; data: string }) => {
        this.handleRawFrame(evt.data, evt.address);
      }),
    );

    await BlePeripheral.start().catch((e: any) =>
      console.warn('BlePeripheral.start failed:', e),
    );
  }

  // ─── Central role (ble-plx) ──────────────────────────────────────────────

  private startScanLoop(): void {
    this.runScan();
    this.scanTimer = setInterval(() => this.runScan(), SCAN_INTERVAL_MS);
  }

  private runScan(): void {
    if (this.destroyed || this.scanning) return;
    this.scanning = true;

    this.ble.startDeviceScan(
      [SERVICE_UUID],
      { allowDuplicates: false },
      (err, device) => {
        if (err || !device) return;
        if (
          !this.centralConns.has(device.id) &&
          !this.peripheralConns.has(device.id)
        ) {
          this.connectAsCentral(device);
        }
      },
    );

    setTimeout(() => {
      this.ble.stopDeviceScan();
      this.scanning = false;
    }, SCAN_DURATION_MS);
  }

  private async connectAsCentral(device: Device): Promise<void> {
    try {
      const connected = await this.ble.connectToDevice(device.id);
      await connected.discoverAllServicesAndCharacteristics();
      await connected.requestMTU(MTU);

      this.centralConns.set(device.id, connected);

      connected.monitorCharacteristicForService(SERVICE_UUID, RX_UUID, (err, char) => {
        if (err || !char?.value) return;
        try {
          const raw = base64ToUtf8(char.value);
          this.handleRawFrame(raw, device.id);
        } catch { /* drop single corrupted frame, keep session alive */ }
      });

      connected.onDisconnected(() => {
        this.centralConns.delete(device.id);
        this.dropPeersByLink(device.id);
      });

      this.sendHandshake(device.id);
    } catch { /* device unreachable */ }
  }

  // ─── BLE framing ─────────────────────────────────────────────────────────

  private handleRawFrame(raw: string, deviceId: string): void {
    const f = parseFrameHeader(raw);
    if (!f) return;

    if (!this.reassembly.has(deviceId)) this.reassembly.set(deviceId, new Map());
    const devBuf = this.reassembly.get(deviceId)!;

    if (!devBuf.has(f.seq)) {
      devBuf.set(f.seq, { chunks: new Array(f.total).fill(undefined), total: f.total });
    }
    const entry = devBuf.get(f.seq)!;
    entry.chunks[f.idx] = f.data;

    if (entry.chunks.every(c => c !== undefined)) {
      devBuf.delete(f.seq);
      const json = (entry.chunks as string[]).join('');
      try {
        const pkt = JSON.parse(json) as BTPacket;
        this.handlePacket(pkt, deviceId);
      } catch { /* malformed */ }
    }
  }

  // ─── Write (both roles) ──────────────────────────────────────────────────

  private enqueue(deviceId: string, task: () => Promise<void>): void {
    const prev = this.writeQueues.get(deviceId) ?? Promise.resolve();
    const next = prev.then(() => task()).catch(() => {});
    this.writeQueues.set(deviceId, next);
  }

  private sendFrames(deviceId: string, frames: string[]): void {
    for (const frame of frames) {
      this.enqueue(deviceId, () => this.sendOneFrame(deviceId, frame));
    }
  }

  private async sendOneFrame(deviceId: string, frame: string): Promise<void> {
    const centralDev = this.centralConns.get(deviceId);
    if (centralDev) {
      const b64 = utf8ToBase64(frame);
      // Exponential backoff: 200 → 400 → 800 → 1600 → 3200 ms (~6 s window).
      // Slow devices (or congested ATT) fire GATT_ERROR 133 transiently; a short
      // window caused premature dropPeer → reconnect on every burst of messages.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await centralDev.writeCharacteristicWithResponseForService(SERVICE_UUID, TX_UUID, b64);
          return;
        } catch {
          if (attempt < 4) await sleep(200 * (1 << attempt));
        }
      }
      this.centralConns.delete(deviceId);
      this.dropPeersByLink(deviceId);
      // Explicitly close the BLE link so the remote device receives a disconnect
      // event and clears its own peer/ratchet state.  Without this the remote
      // still considers us connected (old ratchet seqNums intact), so when we
      // reconnect and exchange a fresh HANDSHAKE the seqNum mismatch silently
      // drops every message.
      try { await centralDev.cancelConnection(); } catch {}
      return;
    }

    if (this.peripheralConns.has(deviceId)) {
      const { BlePeripheral } = NativeModules;
      // Same backoff on the peripheral notify path: 150 → 300 → 600 → 1200 ms.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await BlePeripheral?.send(deviceId, frame);
          return;
        } catch {
          if (attempt < 3) await sleep(150 * (1 << attempt));
        }
      }
      this.peripheralConns.delete(deviceId);
      this.dropPeersByLink(deviceId);
    }
  }

  // Waits for everything currently in the write queue to finish
  private drainQueue(deviceId: string): Promise<void> {
    return this.writeQueues.get(deviceId) ?? Promise.resolve();
  }

  private writeToDevice(deviceId: string, pkt: BTPacket): void {
    const json   = JSON.stringify(pkt);
    const seq    = nextSeq();
    const frames = buildFrames(json, seq);
    this.sendFrames(deviceId, frames);
  }

  // ─── Packet dispatch ─────────────────────────────────────────────────────

  private handlePacket(pkt: BTPacket, fromDeviceId: string): void {
    switch (pkt.type) {
      case 'HANDSHAKE':   this.handleHandshake(pkt, fromDeviceId);   break;
      case 'GENERAL':     this.handleGeneral(pkt, fromDeviceId);     break;
      case 'DM':          this.handleDM(pkt, fromDeviceId);          break;
      case 'MEDIA_START': this.handleMediaStart(pkt, fromDeviceId);  break;
      case 'MEDIA_CHUNK': this.handleMediaChunk(pkt, fromDeviceId);  break;
      case 'MEDIA_END':   this.handleMediaEnd(pkt, fromDeviceId);    break;
      case 'COVER':       /* intentionally ignored */                 break;
      case 'DISCONNECT':  this.dropPeersByLink(fromDeviceId);        break;
    }
  }

  // ─── Handshake ───────────────────────────────────────────────────────────

  private handleHandshake(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.publicKey || !pkt.anonymousId || !this.keyPair) return;

    // Directed HANDSHAKE (to: field set) not meant for us — relay toward target.
    if (pkt.to && pkt.to !== this.anonymousId) {
      this.relayToward(pkt, pkt.to, fromDeviceId);
      return;
    }

    // Don't process our own HANDSHAKE that looped back.
    if (pkt.anonymousId === this.anonymousId) return;

    // Determine the peer key: direct BLE link or virtual multi-hop peer.
    const isDirectBle = this.centralConns.has(fromDeviceId) || this.peripheralConns.has(fromDeviceId);
    const peerKey     = isDirectBle ? fromDeviceId : `${VIRT}${pkt.anonymousId}`;
    const isNewPeer   = !this.peers.has(peerKey);

    const theirPub     = fromHex(pkt.publicKey);
    const sharedSecret = deriveSharedSecret(this.keyPair.privateKey, theirPub);
    const sas          = deriveSAS(sharedSecret);

    // Only initialise ratchets for brand-new peers.  Re-initialising on a
    // duplicate HANDSHAKE (e.g. proactive retry + peripheral reply both land)
    // would reset seqNums while the remote side has already advanced, causing
    // every subsequent message to fail the seqNum check.
    if (isNewPeer) {
      this.sendRatchets.set(peerKey, initRatchet(sharedSecret));
      this.recvRatchets.set(peerKey, initRatchet(sharedSecret));
    }
    this.anonToPeerKey.set(pkt.anonymousId, peerKey);

    this.peers.set(peerKey, {
      deviceId:     peerKey,
      anonymousId:  pkt.anonymousId,
      publicKeyHex: pkt.publicKey,
      sas,
      connected: true,
    });

    if (!isDirectBle) {
      // Record which BLE link to use when routing to this virtual peer.
      this.virtualRoutes.set(peerKey, fromDeviceId);
    }

    this.notifyPeers();

    // Peripheral reply: our proactive sendHandshake fired before they subscribed;
    // now that their TX write proves they're ready, send ours.
    if (isNewPeer && isDirectBle && this.peripheralConns.has(fromDeviceId)) {
      this.sendHandshake(fromDeviceId);
    }

    // For virtual peers, send a directed HANDSHAKE so they can complete the
    // key exchange on their side.
    if (isNewPeer && !isDirectBle) {
      this.sendHandshakeDirected(pkt.anonymousId, fromDeviceId);
    }

    // Relay broadcast HANDSHAKE (no `to` field) to other direct BLE peers
    // so they can discover and key-exchange with multi-hop neighbours.
    if (isNewPeer && !pkt.to && (pkt.ttl ?? MESH_TTL) > 0) {
      this.relayHandshake(pkt, fromDeviceId);
    }
  }

  private sendHandshake(deviceId: string): void {
    if (!this.keyPair) return;
    this.writeToDevice(deviceId, {
      type: 'HANDSHAKE', id: generateMessageId(),
      from: this.anonymousId, ttl: MESH_TTL,
      publicKey: toHex(this.keyPair.publicKey),
      anonymousId: this.anonymousId,
    });
  }

  private sendHandshakeDirected(targetAnonymousId: string, viaDeviceId: string): void {
    if (!this.keyPair) return;
    this.writeToDevice(viaDeviceId, {
      type: 'HANDSHAKE', id: generateMessageId(),
      from: this.anonymousId, to: targetAnonymousId, ttl: MESH_TTL,
      publicKey: toHex(this.keyPair.publicKey),
      anonymousId: this.anonymousId,
    });
  }

  private relayHandshake(pkt: BTPacket, receivedFrom: string): void {
    const fwd = { ...pkt, ttl: (pkt.ttl ?? MESH_TTL) - 1 };
    // Forward to all direct BLE links except the one it came from.
    const sent = new Set<string>();
    for (const deviceId of [
      ...this.centralConns.keys(),
      ...this.peripheralConns.keys(),
    ]) {
      if (deviceId !== receivedFrom && !sent.has(deviceId)) {
        sent.add(deviceId);
        this.writeToDevice(deviceId, fwd);
      }
    }
  }

  // Route a directed packet toward a peer identified by anonymousId.
  // Uses virtualRoutes if known, otherwise floods to all direct BLE links.
  private relayToward(pkt: BTPacket, targetAnonymousId: string, receivedFrom: string): void {
    if ((pkt.ttl ?? 0) <= 0) return;
    const fwd = { ...pkt, ttl: (pkt.ttl ?? 1) - 1 };

    const peerKey = this.anonToPeerKey.get(targetAnonymousId);
    const nextHop = peerKey ? (this.virtualRoutes.get(peerKey) ?? peerKey) : null;

    if (nextHop && nextHop !== receivedFrom) {
      this.writeToDevice(nextHop, fwd);
    } else {
      // Route unknown — flood to all direct peers except sender.
      const sent = new Set<string>();
      for (const deviceId of [
        ...this.centralConns.keys(),
        ...this.peripheralConns.keys(),
      ]) {
        if (deviceId !== receivedFrom && !sent.has(deviceId)) {
          sent.add(deviceId);
          this.writeToDevice(deviceId, fwd);
        }
      }
    }
  }

  // Returns the actual BLE link deviceId to use when sending to a peerKey.
  private linkFor(peerKey: string): string {
    return this.virtualRoutes.get(peerKey) ?? peerKey;
  }

  // ─── Ratchet helpers ─────────────────────────────────────────────────────

  private ratchetEncryptFor(
    deviceId: string,
    plaintext: string,
  ): { data: string; nonce: string; seqNum: number } | null {
    const state = this.sendRatchets.get(deviceId);
    if (!state) return null;
    const { messageKey, seqNum } = ratchetSend(state);
    const enc = encrypt(plaintext, messageKey);
    messageKey.fill(0);
    return { ...enc, seqNum };
  }

  private ratchetDecryptFrom(
    deviceId: string,
    pkt: { data?: string; nonce?: string },
    seqNum: number,
  ): string | null {
    if (!pkt.data || !pkt.nonce) return null;
    const state = this.recvRatchets.get(deviceId);
    if (!state) return null;
    const messageKey = ratchetRecv(state, seqNum);
    if (!messageKey) return null;
    try {
      const plain = decrypt({ data: pkt.data, nonce: pkt.nonce }, messageKey);
      messageKey.fill(0);
      return plain;
    } catch {
      return null;
    }
  }

  // ─── GENERAL ─────────────────────────────────────────────────────────────

  private handleGeneral(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.data || !pkt.nonce || pkt.seqNum === undefined) return;
    if (this.seenIds.has(pkt.id)) return;
    this.seenIds.set(pkt.id, Date.now());

    // Find the peer key for the original sender (pkt.from = anonymousId).
    const peerKey = this.anonToPeerKey.get(pkt.from);
    if (!peerKey) return;
    const peer = this.peers.get(peerKey);
    if (!peer) return;

    const plain = this.ratchetDecryptFrom(peerKey, pkt, pkt.seqNum);
    if (plain === null) return;

    this.onMessage?.({ ...pkt, data: plain, from: peer.anonymousId }, fromDeviceId);
    this.relayGeneral(pkt, fromDeviceId, plain);
  }

  private relayGeneral(original: BTPacket, receivedFrom: string, plain: string): void {
    for (const [peerKey] of this.peers) {
      const link = this.linkFor(peerKey);
      if (link === receivedFrom) continue; // don't send back the way it came
      const enc = this.ratchetEncryptFor(peerKey, plain);
      if (!enc) continue;
      this.writeToDevice(link, {
        ...original,
        from:   original.from,
        data:   enc.data,
        nonce:  enc.nonce,
        seqNum: enc.seqNum,
      });
    }
  }

  // ─── DM ──────────────────────────────────────────────────────────────────

  private handleDM(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.data || !pkt.nonce || pkt.seqNum === undefined) return;
    if (this.seenIds.has(pkt.id)) return;
    this.seenIds.set(pkt.id, Date.now());

    const isForMe = pkt.to === this.anonymousId;
    const isRelay = !isForMe && !!pkt.to;

    const senderKey = this.anonToPeerKey.get(pkt.from);

    if (isForMe) {
      if (!senderKey) return;
      const peer = this.peers.get(senderKey);
      if (!peer) return;
      const plain = this.ratchetDecryptFrom(senderKey, pkt, pkt.seqNum);
      if (plain === null) return;
      this.onMessage?.({ ...pkt, data: plain, from: peer.anonymousId }, fromDeviceId);
    } else if (isRelay) {
      if (!senderKey) return;
      const plain = this.ratchetDecryptFrom(senderKey, pkt, pkt.seqNum);
      if (plain === null) return;

      const targetKey = this.anonToPeerKey.get(pkt.to!);
      if (!targetKey) return;
      const enc = this.ratchetEncryptFor(targetKey, plain);
      if (!enc) return;
      const link = this.linkFor(targetKey);
      if (link === fromDeviceId) return; // would loop back
      this.writeToDevice(link, {
        ...pkt,
        from:   pkt.from,
        data:   enc.data,
        nonce:  enc.nonce,
        seqNum: enc.seqNum,
      });
    }
  }

  // ─── Media ───────────────────────────────────────────────────────────────

  private handleMediaStart(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.mediaId || !pkt.totalChunks) return;
    const key = pkt.from; // index by sender's anonymousId
    if (!this.pendingMedia.has(key)) this.pendingMedia.set(key, new Map());
    this.pendingMedia.get(key)!.set(pkt.mediaId, []);
  }

  private handleMediaChunk(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.mediaId || pkt.chunkIndex === undefined || !pkt.data || !pkt.nonce || pkt.seqNum === undefined) return;
    const senderKey = this.anonToPeerKey.get(pkt.from);
    if (!senderKey) return;
    const chunks = this.pendingMedia.get(pkt.from)?.get(pkt.mediaId);
    if (!chunks) return;
    const plain = this.ratchetDecryptFrom(senderKey, pkt, pkt.seqNum);
    if (plain !== null) chunks[pkt.chunkIndex] = plain;
  }

  private handleMediaEnd(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.mediaId) return;
    const devMap = this.pendingMedia.get(pkt.from);
    const chunks = devMap?.get(pkt.mediaId);
    if (!chunks) return;
    devMap?.delete(pkt.mediaId);

    this.onMessage?.(
      { ...pkt, id: pkt.id ?? pkt.mediaId, from: pkt.from, data: chunks.filter(Boolean).join('') },
      fromDeviceId,
    );
  }

  // ─── Public send API ─────────────────────────────────────────────────────

  sendGeneral(plain: string): void {
    const id = generateMessageId();
    this.seenIds.set(id, Date.now());
    for (const [peerKey] of this.peers) {
      const enc = this.ratchetEncryptFor(peerKey, plain);
      if (!enc) continue;
      this.writeToDevice(this.linkFor(peerKey), {
        type: 'GENERAL', id, from: this.anonymousId, ttl: MESH_TTL,
        data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
      });
    }
  }

  sendDM(targetAnonymousId: string, plain: string): void {
    const peerKey = this.anonToPeerKey.get(targetAnonymousId);
    if (!peerKey) return;
    const enc = this.ratchetEncryptFor(peerKey, plain);
    if (!enc) return;
    this.writeToDevice(this.linkFor(peerKey), {
      type: 'DM', id: generateMessageId(), ttl: MESH_TTL,
      from: this.anonymousId, to: targetAnonymousId,
      data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
    });
  }

  async sendMediaGeneral(base64: string, mediaKind: MediaKind, mimeType: string): Promise<void> {
    for (const [peerKey] of this.peers) {
      await this.sendMediaToPeer(peerKey, base64, mediaKind, mimeType, undefined);
    }
  }

  async sendMediaDM(
    targetAnonymousId: string, base64: string,
    mediaKind: MediaKind, mimeType: string,
  ): Promise<void> {
    const peerKey = this.anonToPeerKey.get(targetAnonymousId);
    if (!peerKey) return;
    await this.sendMediaToPeer(peerKey, base64, mediaKind, mimeType, targetAnonymousId);
  }

  private async sendMediaToPeer(
    peerKey: string, base64: string,
    mediaKind: MediaKind, mimeType: string, to: string | undefined,
  ): Promise<void> {
    const link      = this.linkFor(peerKey);
    const mediaId   = generateMessageId();
    const messageId = generateMessageId();
    const chunks    = splitBase64IntoChunks(base64);

    this.writeToDevice(link, {
      type: 'MEDIA_START', id: messageId, from: this.anonymousId,
      to, mediaId, mediaKind, mimeType, totalChunks: chunks.length,
    });
    await this.drainQueue(link);

    for (let i = 0; i < chunks.length; i++) {
      if (!this.peers.has(peerKey)) return;

      const enc = this.ratchetEncryptFor(peerKey, chunks[i]);
      if (!enc) continue;
      this.writeToDevice(link, {
        type: 'MEDIA_CHUNK', id: generateMessageId(), from: this.anonymousId,
        to, mediaId, chunkIndex: i, totalChunks: chunks.length,
        data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
      });
      await this.drainQueue(link);
      await sleep(30);
    }

    if (this.peers.has(peerKey)) {
      this.writeToDevice(link, {
        type: 'MEDIA_END', id: messageId, from: this.anonymousId,
        to, mediaId, mediaKind, mimeType,
      });
      await this.drainQueue(link);
    }
  }

  // ─── Cover traffic ───────────────────────────────────────────────────────

  private scheduleCoverTraffic(): void {
    const delay =
      COVER_INTERVAL_MIN_MS +
      Math.random() * (COVER_INTERVAL_MAX_MS - COVER_INTERVAL_MIN_MS);
    this.coverTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.sendCover();
        this.scheduleCoverTraffic();
      }
    }, delay);
  }

  private sendCover(): void {
    if (this.peers.size === 0) return;
    // Only send cover traffic to direct BLE peers (not virtual — pointless over relay).
    const directKeys = Array.from(this.peers.keys()).filter(k => !k.startsWith(VIRT));
    if (directKeys.length === 0) return;
    const peerKey = directKeys[Math.floor(Math.random() * directKeys.length)];
    // Do NOT encrypt with the ratchet: the receiver ignores COVER packets without
    // advancing its recv-ratchet, which would permanently desync the seqNums.
    this.writeToDevice(peerKey, { type: 'COVER', id: generateMessageId(), from: '' });
  }

  // ─── Peer management ─────────────────────────────────────────────────────

  // Drop a peer by peerKey (deviceId for direct, 'virtual:anon' for multi-hop).
  private dropPeer(peerKey: string): void {
    const peer = this.peers.get(peerKey);
    if (!peer) return;
    this.anonToPeerKey.delete(peer.anonymousId);
    this.virtualRoutes.delete(peerKey);
    this.peers.delete(peerKey);
    this.sendRatchets.get(peerKey)?.chainKey.fill(0);
    this.recvRatchets.get(peerKey)?.chainKey.fill(0);
    this.sendRatchets.delete(peerKey);
    this.recvRatchets.delete(peerKey);
    this.reassembly.delete(peerKey);
    this.writeQueues.delete(peerKey);
    this.notifyPeers();
  }

  // Drop all peers (direct and virtual) that route through a given BLE link,
  // then immediately start a new scan cycle so we reconnect as fast as possible
  // instead of waiting for the next scheduled 12-second interval.
  private dropPeersByLink(deviceId: string): void {
    this.dropPeer(deviceId);
    for (const [peerKey, link] of this.virtualRoutes) {
      if (link === deviceId) this.dropPeer(peerKey);
    }
    this.runScan();
  }

  private getPeerByAnonymousId(anonymousId: string): [string, Peer] | null {
    const key = this.anonToPeerKey.get(anonymousId);
    if (!key) return null;
    const peer = this.peers.get(key);
    return peer ? [key, peer] : null;
  }

  private notifyPeers(): void {
    this.onPeersChange?.(Array.from(this.peers.values()));
  }

  getPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  // ─── Destroy ─────────────────────────────────────────────────────────────

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.scanTimer)        clearInterval(this.scanTimer);
    if (this.seenCleanupTimer) clearInterval(this.seenCleanupTimer);
    if (this.coverTimer)       clearTimeout(this.coverTimer);
    this.appStateSub?.remove?.();
    for (const sub of this.peripheralSubs) sub?.remove?.();

    const bye: BTPacket = { type: 'DISCONNECT', id: generateMessageId(), from: this.anonymousId };
    for (const deviceId of this.peers.keys()) this.writeToDevice(deviceId, bye);

    for (const dev of this.centralConns.values()) {
      try { dev.cancelConnection(); } catch {}
    }

    const { BlePeripheral } = NativeModules;
    BlePeripheral?.stop().catch(() => {});

    for (const s of this.sendRatchets.values()) s.chainKey.fill(0);
    for (const s of this.recvRatchets.values()) s.chainKey.fill(0);

    this.ble.destroy();
    this.centralConns.clear();
    this.peripheralConns.clear();
    this.peers.clear();
    this.sendRatchets.clear();
    this.recvRatchets.clear();
    this.reassembly.clear();
    this.writeQueues.clear();
    this.pendingMedia.clear();
    this.seenIds.clear();
    this.virtualRoutes.clear();
    this.anonToPeerKey.clear();
    this.keyPair = null;
    this.anonymousId = '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export const bluetoothService = new BluetoothService();
