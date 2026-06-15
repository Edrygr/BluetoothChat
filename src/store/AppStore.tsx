/**
 * In-memory only store — nothing is ever written to disk.
 * All state is cleared when the component unmounts (app close/background).
 */
import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import RNFS from 'react-native-fs';
import { BTPacket, ChatMessage, MediaKind, MessagePayload, Peer } from '../types';
import { bluetoothService } from '../bluetooth/BluetoothService';
import { generateMessageId } from '../utils/identity';

// ─── State ────────────────────────────────────────────────────────────────────

interface AppState {
  selfId: string;
  peers: Peer[];
  generalMessages: ChatMessage[];
  dmMessages: Record<string, ChatMessage[]>; // keyed by peer anonymousId
  isReady: boolean;
  error: string | null;
  selfDestructTTL: number; // 0 = off, or seconds
}

type Action =
  | { type: 'SET_READY'; selfId: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'SET_PEERS'; peers: Peer[] }
  | { type: 'ADD_GENERAL'; message: ChatMessage }
  | { type: 'ADD_DM'; peerId: string; message: ChatMessage }
  | { type: 'SET_TTL'; ttl: number }
  | { type: 'EXPIRE_MESSAGES' }
  | { type: 'PANIC' };

const initial: AppState = {
  selfId: '',
  peers: [],
  generalMessages: [],
  dmMessages: {},
  isReady: false,
  error: null,
  selfDestructTTL: 0,
};

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'SET_READY':
      return { ...s, isReady: true, selfId: a.selfId };
    case 'SET_ERROR':
      return { ...s, error: a.error };
    case 'SET_PEERS':
      return { ...s, peers: a.peers };
    case 'ADD_GENERAL':
      return { ...s, generalMessages: [...s.generalMessages, a.message] };
    case 'ADD_DM': {
      const prev = s.dmMessages[a.peerId] ?? [];
      return { ...s, dmMessages: { ...s.dmMessages, [a.peerId]: [...prev, a.message] } };
    }
    case 'SET_TTL':
      return { ...s, selfDestructTTL: a.ttl };
    case 'EXPIRE_MESSAGES': {
      const now = Date.now();
      const filterExpired = (msgs: ChatMessage[]) =>
        msgs.filter(m => !m.expiresAt || m.expiresAt > now);
      const newDMs: Record<string, ChatMessage[]> = {};
      for (const [k, v] of Object.entries(s.dmMessages)) {
        newDMs[k] = filterExpired(v);
      }
      return {
        ...s,
        generalMessages: filterExpired(s.generalMessages),
        dmMessages: newDMs,
      };
    }
    case 'PANIC':
      return { ...initial };
    default:
      return s;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface AppContextValue {
  state: AppState;
  sendGeneral: (text: string) => void;
  sendDM: (peerId: string, text: string) => void;
  sendMediaGeneral: (localUri: string, mediaKind: MediaKind, mimeType: string) => Promise<void>;
  sendMediaDM: (peerId: string, localUri: string, mediaKind: MediaKind, mimeType: string) => Promise<void>;
  setSelfDestructTTL: (ttl: number) => void;
  panic: () => void;
}

const AppContext = createContext<AppContextValue>(null as any);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Self-destruct sweep — runs every second, only does real work when messages expire
  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: 'EXPIRE_MESSAGES' }), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleIncoming = useCallback(async (pkt: BTPacket, _fromDeviceId: string) => {
    if (pkt.type === 'GENERAL' || pkt.type === 'DM') {
      const payload = parsePayload(pkt.data ?? '');
      const msg: ChatMessage = {
        id: pkt.id,
        fromId: pkt.from,
        fromSelf: false,
        content: payload.text,
        kind: 'text',
        timestamp: Date.now(),
        isDM: pkt.type === 'DM',
        peerId: pkt.type === 'DM' ? pkt.from : undefined,
        expiresAt: payload.ttl ? Date.now() + payload.ttl * 1000 : undefined,
      };
      if (pkt.type === 'DM') {
        dispatch({ type: 'ADD_DM', peerId: pkt.from, message: msg });
      } else {
        dispatch({ type: 'ADD_GENERAL', message: msg });
      }
    } else if (pkt.type === 'MEDIA_END') {
      await handleIncomingMedia(pkt, dispatch);
    }
  }, []);

  const handlePeersChange = useCallback((peers: Peer[]) => {
    dispatch({ type: 'SET_PEERS', peers });
  }, []);

  useEffect(() => {
    bluetoothService
      .init(handleIncoming, handlePeersChange)
      .then(() => dispatch({ type: 'SET_READY', selfId: bluetoothService.anonymousId }))
      .catch(err => dispatch({ type: 'SET_ERROR', error: String(err) }));

    return () => {
      bluetoothService.destroy();
      cleanupTempFiles();
    };
  }, [handleIncoming, handlePeersChange]);

  const sendGeneral = useCallback((text: string) => {
    const ttl = stateRef.current.selfDestructTTL;
    const payload = buildPayload(text, ttl);
    const msg: ChatMessage = {
      id: generateMessageId(),
      fromId: stateRef.current.selfId,
      fromSelf: true,
      content: text,
      kind: 'text',
      timestamp: Date.now(),
      isDM: false,
      expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
    };
    dispatch({ type: 'ADD_GENERAL', message: msg });
    bluetoothService.sendGeneral(payload);
  }, []);

  const sendDM = useCallback((peerId: string, text: string) => {
    const ttl = stateRef.current.selfDestructTTL;
    const payload = buildPayload(text, ttl);
    const msg: ChatMessage = {
      id: generateMessageId(),
      fromId: stateRef.current.selfId,
      fromSelf: true,
      content: text,
      kind: 'text',
      timestamp: Date.now(),
      isDM: true,
      peerId,
      expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
    };
    dispatch({ type: 'ADD_DM', peerId, message: msg });
    bluetoothService.sendDM(peerId, payload);
  }, []);

  const sendMediaGeneral = useCallback(async (
    localUri: string, mediaKind: MediaKind, mimeType: string,
  ) => {
    const base64 = await RNFS.readFile(localUri, 'base64');
    dispatch({
      type: 'ADD_GENERAL',
      message: {
        id: generateMessageId(),
        fromId: stateRef.current.selfId,
        fromSelf: true,
        content: '',
        kind: mediaKind,
        localUri,
        mediaKind,
        timestamp: Date.now(),
        isDM: false,
      },
    });
    await bluetoothService.sendMediaGeneral(base64, mediaKind, mimeType);
  }, []);

  const sendMediaDM = useCallback(async (
    peerId: string, localUri: string, mediaKind: MediaKind, mimeType: string,
  ) => {
    const base64 = await RNFS.readFile(localUri, 'base64');
    dispatch({
      type: 'ADD_DM',
      peerId,
      message: {
        id: generateMessageId(),
        fromId: stateRef.current.selfId,
        fromSelf: true,
        content: '',
        kind: mediaKind,
        localUri,
        mediaKind,
        timestamp: Date.now(),
        isDM: true,
        peerId,
      },
    });
    await bluetoothService.sendMediaDM(peerId, base64, mediaKind, mimeType);
  }, []);

  const setSelfDestructTTL = useCallback((ttl: number) => {
    dispatch({ type: 'SET_TTL', ttl });
  }, []);

  const panic = useCallback(() => {
    bluetoothService.destroy();
    cleanupTempFiles();
    dispatch({ type: 'PANIC' });
  }, []);

  return (
    <AppContext.Provider value={{
      state,
      sendGeneral,
      sendDM,
      sendMediaGeneral,
      sendMediaDM,
      setSelfDestructTTL,
      panic,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPayload(text: string, ttl: number): string {
  const p: MessagePayload = { text };
  if (ttl > 0) p.ttl = ttl;
  return JSON.stringify(p);
}

function parsePayload(raw: string): MessagePayload {
  try {
    const p = JSON.parse(raw);
    if (typeof p.text === 'string') return p as MessagePayload;
  } catch {}
  return { text: raw }; // fallback for plain-text messages
}

async function handleIncomingMedia(
  pkt: BTPacket,
  dispatch: React.Dispatch<Action>,
): Promise<void> {
  if (!pkt.data || !pkt.mediaKind) return;
  const ext = pkt.mimeType?.split('/')[1] ?? (pkt.mediaKind === 'video' ? 'mp4' : 'jpg');
  const tmpPath = `${RNFS.CachesDirectoryPath}/btchat_${pkt.mediaId}.${ext}`;
  await RNFS.writeFile(tmpPath, pkt.data, 'base64');

  const msg: ChatMessage = {
    id: pkt.id ?? pkt.mediaId ?? generateMessageId(),
    fromId: pkt.from,
    fromSelf: false,
    content: '',
    kind: pkt.mediaKind,
    localUri: `file://${tmpPath}`,
    mediaKind: pkt.mediaKind,
    timestamp: Date.now(),
    isDM: !!pkt.to,
    peerId: pkt.to ? pkt.from : undefined,
  };

  if (pkt.to) {
    dispatch({ type: 'ADD_DM', peerId: pkt.from, message: msg });
  } else {
    dispatch({ type: 'ADD_GENERAL', message: msg });
  }
}

async function cleanupTempFiles(): Promise<void> {
  try {
    const files = await RNFS.readdir(RNFS.CachesDirectoryPath);
    await Promise.all(
      files
        .filter(f => f.startsWith('btchat_'))
        .map(f => RNFS.unlink(`${RNFS.CachesDirectoryPath}/${f}`).catch(() => {})),
    );
  } catch {}
}
