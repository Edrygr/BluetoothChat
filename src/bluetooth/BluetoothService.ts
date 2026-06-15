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
        this.dropPeer(address);
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
        const raw = base64ToUtf8(char.value);
        this.handleRawFrame(raw, device.id);
      });

      connected.onDisconnected(() => {
        this.centralConns.delete(device.id);
        this.dropPeer(device.id);
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
      try {
        // Write-without-response avoids blocking the ATT layer, which prevents
        // a deadlock when the peer is simultaneously sending us a notification.
        await centralDev.writeCharacteristicWithoutResponseForService(SERVICE_UUID, TX_UUID, b64);
      } catch {
        // Only drop if the BLE connection is actually gone; transient ATT
        // errors should not destroy the session state.
        const alive = await centralDev.isConnected().catch(() => false);
        if (!alive) {
          this.centralConns.delete(deviceId);
          this.dropPeer(deviceId);
        }
      }
      return;
    }

    if (this.peripheralConns.has(deviceId)) {
      const { BlePeripheral } = NativeModules;
      try {
        await BlePeripheral?.send(deviceId, frame);
      } catch {
        // Notification can fail transiently (ATT busy) when both sides write at
        // the same moment. Swallow the error; the BlePeripheralCentralDisconnected
        // event will clean up if the peer truly disconnected.
      }
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
      case 'DISCONNECT':  this.dropPeer(fromDeviceId);               break;
    }
  }

  // ─── Handshake ───────────────────────────────────────────────────────────

  private handleHandshake(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.publicKey || !pkt.anonymousId || !this.keyPair) return;

    const isNewPeer    = !this.peers.has(fromDeviceId);
    const theirPub     = fromHex(pkt.publicKey);
    const sharedSecret = deriveSharedSecret(this.keyPair.privateKey, theirPub);
    const sas          = deriveSAS(sharedSecret);

    this.sendRatchets.set(fromDeviceId, initRatchet(sharedSecret));
    this.recvRatchets.set(fromDeviceId, initRatchet(sharedSecret));

    this.peers.set(fromDeviceId, {
      deviceId:    fromDeviceId,
      anonymousId: pkt.anonymousId,
      publicKeyHex: pkt.publicKey,
      sas,
      connected: true,
    });
    this.notifyPeers();

    // When we are the PERIPHERAL for this device, the proactive handshake
    // we sent in BlePeripheralCentralConnected fired before they subscribed
    // to RX notifications and was silently dropped. Now that they have
    // subscribed and sent us their handshake via TX write, reply with ours
    // so they can complete key exchange on their end.
    if (isNewPeer && this.peripheralConns.has(fromDeviceId)) {
      this.sendHandshake(fromDeviceId);
    }
  }

  private sendHandshake(deviceId: string): void {
    if (!this.keyPair) return;
    this.writeToDevice(deviceId, {
      type:        'HANDSHAKE',
      id:          generateMessageId(),
      from:        this.anonymousId,
      publicKey:   toHex(this.keyPair.publicKey),
      anonymousId: this.anonymousId,
    });
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

    const peer = this.peers.get(fromDeviceId);
    if (!peer) return;

    const plain = this.ratchetDecryptFrom(fromDeviceId, pkt, pkt.seqNum);
    if (plain === null) return;

    this.onMessage?.({ ...pkt, data: plain, from: peer.anonymousId }, fromDeviceId);
    this.relayGeneral(pkt, fromDeviceId, plain);
  }

  private relayGeneral(original: BTPacket, receivedFrom: string, plain: string): void {
    for (const [deviceId] of this.peers) {
      if (deviceId === receivedFrom) continue;
      const enc = this.ratchetEncryptFor(deviceId, plain);
      if (!enc) continue;
      this.writeToDevice(deviceId, {
        ...original,
        from:   '',
        data:   enc.data,
        nonce:  enc.nonce,
        seqNum: enc.seqNum,
      });
    }
  }

  // ─── DM ──────────────────────────────────────────────────────────────────

  private handleDM(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.data || !pkt.nonce || pkt.seqNum === undefined) return;

    const isForMe = pkt.to === this.anonymousId;
    const isRelay = !isForMe && !!pkt.to;

    if (isForMe) {
      const peer = this.peers.get(fromDeviceId);
      if (!peer) return;
      const plain = this.ratchetDecryptFrom(fromDeviceId, pkt, pkt.seqNum);
      if (plain === null) return;
      this.onMessage?.({ ...pkt, data: plain, from: peer.anonymousId }, fromDeviceId);
    } else if (isRelay) {
      const srcPeer = this.peers.get(fromDeviceId);
      if (!srcPeer) return;
      const plain = this.ratchetDecryptFrom(fromDeviceId, pkt, pkt.seqNum);
      if (plain === null) return;

      const target = this.getPeerByAnonymousId(pkt.to!);
      if (!target) return;
      const [targetId] = target;
      const enc = this.ratchetEncryptFor(targetId, plain);
      if (!enc) return;
      this.writeToDevice(targetId, {
        ...pkt,
        from:   '',
        data:   enc.data,
        nonce:  enc.nonce,
        seqNum: enc.seqNum,
      });
    }
  }

  // ─── Media ───────────────────────────────────────────────────────────────

  private handleMediaStart(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.mediaId || !pkt.totalChunks) return;
    if (!this.pendingMedia.has(fromDeviceId)) this.pendingMedia.set(fromDeviceId, new Map());
    this.pendingMedia.get(fromDeviceId)!.set(pkt.mediaId, []);
  }

  private handleMediaChunk(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.mediaId || pkt.chunkIndex === undefined || !pkt.data || !pkt.nonce || pkt.seqNum === undefined) return;
    const chunks = this.pendingMedia.get(fromDeviceId)?.get(pkt.mediaId);
    if (!chunks) return;
    const plain = this.ratchetDecryptFrom(fromDeviceId, pkt, pkt.seqNum);
    if (plain !== null) chunks[pkt.chunkIndex] = plain;
  }

  private handleMediaEnd(pkt: BTPacket, fromDeviceId: string): void {
    if (!pkt.mediaId) return;
    const devMap = this.pendingMedia.get(fromDeviceId);
    const chunks = devMap?.get(pkt.mediaId);
    if (!chunks) return;
    devMap?.delete(pkt.mediaId);

    const peer = this.peers.get(fromDeviceId);
    this.onMessage?.(
      { ...pkt, id: pkt.id ?? pkt.mediaId, from: peer?.anonymousId ?? pkt.from, data: chunks.filter(Boolean).join('') },
      fromDeviceId,
    );
  }

  // ─── Public send API ─────────────────────────────────────────────────────

  sendGeneral(plain: string): void {
    const id = generateMessageId();
    this.seenIds.set(id, Date.now());
    for (const [deviceId] of this.peers) {
      const enc = this.ratchetEncryptFor(deviceId, plain);
      if (!enc) continue;
      this.writeToDevice(deviceId, {
        type: 'GENERAL', id, from: this.anonymousId,
        data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
      });
    }
  }

  sendDM(targetAnonymousId: string, plain: string): void {
    const entry = this.getPeerByAnonymousId(targetAnonymousId);
    if (!entry) return;
    const [deviceId] = entry;
    const enc = this.ratchetEncryptFor(deviceId, plain);
    if (!enc) return;
    this.writeToDevice(deviceId, {
      type: 'DM', id: generateMessageId(),
      from: this.anonymousId, to: targetAnonymousId,
      data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
    });
  }

  async sendMediaGeneral(base64: string, mediaKind: MediaKind, mimeType: string): Promise<void> {
    for (const [deviceId] of this.peers) {
      await this.sendMediaToPeer(deviceId, base64, mediaKind, mimeType, undefined);
    }
  }

  async sendMediaDM(
    targetAnonymousId: string, base64: string,
    mediaKind: MediaKind, mimeType: string,
  ): Promise<void> {
    const entry = this.getPeerByAnonymousId(targetAnonymousId);
    if (!entry) return;
    await this.sendMediaToPeer(entry[0], base64, mediaKind, mimeType, targetAnonymousId);
  }

  private async sendMediaToPeer(
    deviceId: string, base64: string,
    mediaKind: MediaKind, mimeType: string, to: string | undefined,
  ): Promise<void> {
    const mediaId   = generateMessageId();
    const messageId = generateMessageId();
    const chunks    = splitBase64IntoChunks(base64);

    this.writeToDevice(deviceId, {
      type: 'MEDIA_START', id: messageId, from: this.anonymousId,
      to, mediaId, mediaKind, mimeType, totalChunks: chunks.length,
    });
    await this.drainQueue(deviceId);

    for (let i = 0; i < chunks.length; i++) {
      // Abort early if peer disconnected mid-transfer
      if (!this.peers.has(deviceId)) return;

      const enc = this.ratchetEncryptFor(deviceId, chunks[i]);
      if (!enc) continue;
      this.writeToDevice(deviceId, {
        type: 'MEDIA_CHUNK', id: generateMessageId(), from: this.anonymousId,
        to, mediaId, chunkIndex: i, totalChunks: chunks.length,
        data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
      });
      // Wait for this chunk's BLE write to complete before queueing the next
      await this.drainQueue(deviceId);
      // Brief pause for receiver-side processing
      await sleep(30);
    }

    if (this.peers.has(deviceId)) {
      this.writeToDevice(deviceId, {
        type: 'MEDIA_END', id: messageId, from: this.anonymousId,
        to, mediaId, mediaKind, mimeType,
      });
      await this.drainQueue(deviceId);
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
    const ids      = Array.from(this.peers.keys());
    const deviceId = ids[Math.floor(Math.random() * ids.length)];
    const enc      = this.ratchetEncryptFor(deviceId, '\x00');
    if (!enc) return;
    this.writeToDevice(deviceId, {
      type: 'COVER', id: generateMessageId(), from: '',
      data: enc.data, nonce: enc.nonce, seqNum: enc.seqNum,
    });
  }

  // ─── Peer management ─────────────────────────────────────────────────────

  private dropPeer(deviceId: string): void {
    if (!this.peers.has(deviceId)) return;
    this.peers.delete(deviceId);
    this.sendRatchets.get(deviceId)?.chainKey.fill(0);
    this.recvRatchets.get(deviceId)?.chainKey.fill(0);
    this.sendRatchets.delete(deviceId);
    this.recvRatchets.delete(deviceId);
    this.reassembly.delete(deviceId);
    this.writeQueues.delete(deviceId);
    this.notifyPeers();
  }

  private getPeerByAnonymousId(anonymousId: string): [string, Peer] | null {
    for (const [id, peer] of this.peers) {
      if (peer.anonymousId === anonymousId) return [id, peer];
    }
    return null;
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
    this.keyPair = null;
    this.anonymousId = '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export const bluetoothService = new BluetoothService();
