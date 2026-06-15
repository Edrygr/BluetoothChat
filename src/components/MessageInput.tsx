import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { MediaKind } from '../types';
import { useApp } from '../store/AppStore';

const TTL_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '30s', value: 30 },
  { label: '5m',  value: 300 },
  { label: '1h',  value: 3600 },
];

interface Props {
  onSendText: (text: string) => void;
  onSendMedia: (localUri: string, mediaKind: MediaKind, mimeType: string) => Promise<void>;
}

export function MessageInput({ onSendText, onSendMedia }: Props) {
  const { state, setSelfDestructTTL } = useApp();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showTTL, setShowTTL] = useState(false);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed);
    setText('');
  }

  async function handleMedia() {
    const result = await launchImageLibrary({
      mediaType: 'mixed',
      includeBase64: false,
      quality: 0.6,
      videoQuality: 'medium',
    });
    if (result.didCancel || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) return;
    const mime = asset.type ?? 'image/jpeg';
    const mediaKind: MediaKind = mime.startsWith('video') ? 'video' : 'image';
    setSending(true);
    try {
      await onSendMedia(asset.uri, mediaKind, mime);
    } catch {
      Alert.alert('Error', 'Could not send media.');
    } finally {
      setSending(false);
    }
  }

  const currentTTL = state.selfDestructTTL;
  const ttlLabel = TTL_OPTIONS.find(o => o.value === currentTTL)?.label ?? 'Off';

  return (
    <View>
      {/* Self-destruct TTL picker */}
      {showTTL && (
        <View style={styles.ttlRow}>
          <Text style={styles.ttlLabel}>Self-destruct:</Text>
          {TTL_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.ttlBtn, currentTTL === opt.value && styles.ttlBtnActive]}
              onPress={() => { setSelfDestructTTL(opt.value); setShowTTL(false); }}>
              <Text style={[styles.ttlBtnText, currentTTL === opt.value && styles.ttlBtnTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.row}>
        {/* Media picker */}
        <TouchableOpacity style={styles.iconBtn} onPress={handleMedia} disabled={sending}>
          {sending
            ? <ActivityIndicator color="#0084ff" size="small" />
            : <Text style={styles.icon}>📎</Text>}
        </TouchableOpacity>

        {/* Self-destruct toggle */}
        <TouchableOpacity
          style={[styles.iconBtn, currentTTL > 0 && styles.iconBtnActive]}
          onPress={() => setShowTTL(v => !v)}>
          <Text style={styles.icon}>
            {currentTTL > 0 ? `🔥 ${ttlLabel}` : '🔥'}
          </Text>
        </TouchableOpacity>

        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message"
          placeholderTextColor="#666"
          multiline
          maxLength={2000}
        />

        <TouchableOpacity
          style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!text.trim()}>
          <Text style={styles.sendBtnText}>➤</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    backgroundColor: '#1a1a1e',
    borderTopWidth: 1,
    borderTopColor: '#2a2a2e',
  },
  ttlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e1e22',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  ttlLabel: {
    color: '#888',
    fontSize: 12,
    marginRight: 4,
  },
  ttlBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: '#2a2a2e',
  },
  ttlBtnActive: {
    backgroundColor: '#ff4444',
  },
  ttlBtnText: {
    color: '#aaa',
    fontSize: 12,
  },
  ttlBtnTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  iconBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  iconBtnActive: {
    backgroundColor: 'rgba(255,68,68,0.15)',
    borderRadius: 18,
  },
  icon: {
    fontSize: 20,
  },
  input: {
    flex: 1,
    backgroundColor: '#2a2a2e',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: '#f0f0f0',
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0084ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  sendBtnDisabled: {
    backgroundColor: '#333',
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 16,
  },
});
