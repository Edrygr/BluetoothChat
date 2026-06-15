import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Dimensions,
} from 'react-native';
import Video from 'react-native-video';
import { ChatMessage } from '../types';

const { width: SW } = Dimensions.get('window');

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const [imageModal, setImageModal] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!message.expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((message.expiresAt! - Date.now()) / 1000));
      setRemaining(left);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [message.expiresAt]);

  const isSelf = message.fromSelf;
  const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <View style={[styles.row, isSelf ? styles.rowSelf : styles.rowOther]}>
      {!isSelf && (
        <Text style={styles.sender}>{message.fromId}</Text>
      )}
      <View style={[styles.bubble, isSelf ? styles.bubbleSelf : styles.bubbleOther]}>
        {message.kind === 'text' && (
          <Text style={[styles.text, isSelf ? styles.textSelf : styles.textOther]}>
            {message.content}
          </Text>
        )}

        {message.kind === 'image' && message.localUri && (
          <>
            <TouchableOpacity onPress={() => setImageModal(true)}>
              <Image
                source={{ uri: message.localUri }}
                style={styles.mediaThumb}
                resizeMode="cover"
              />
            </TouchableOpacity>
            <Modal visible={imageModal} transparent onRequestClose={() => setImageModal(false)}>
              <TouchableOpacity style={styles.modalBg} onPress={() => setImageModal(false)}>
                <Image
                  source={{ uri: message.localUri }}
                  style={styles.fullImage}
                  resizeMode="contain"
                />
              </TouchableOpacity>
            </Modal>
          </>
        )}

        {message.kind === 'video' && message.localUri && (
          <Video
            source={{ uri: message.localUri }}
            style={styles.mediaThumb}
            controls
            resizeMode="cover"
            paused
          />
        )}

        <View style={styles.footer}>
          <Text style={styles.time}>{timeStr}</Text>
          {remaining !== null && (
            <Text style={[styles.timer, remaining <= 5 && styles.timerUrgent]}>
              {' · '}
              {remaining > 0 ? `🔥 ${remaining}s` : 'expired'}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  rowSelf: {
    alignItems: 'flex-end',
  },
  rowOther: {
    alignItems: 'flex-start',
  },
  sender: {
    fontSize: 11,
    color: '#888',
    marginBottom: 2,
    marginLeft: 4,
  },
  bubble: {
    maxWidth: SW * 0.72,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleSelf: {
    backgroundColor: '#0084ff',
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: '#2a2a2e',
    borderBottomLeftRadius: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 20,
  },
  textSelf: {
    color: '#fff',
  },
  textOther: {
    color: '#f0f0f0',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  time: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.55)',
  },
  timer: {
    fontSize: 10,
    color: 'rgba(255,200,0,0.8)',
  },
  timerUrgent: {
    color: '#ff4444',
  },
  mediaThumb: {
    width: SW * 0.55,
    height: SW * 0.55 * 0.75,
    borderRadius: 10,
  },
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
    width: SW,
    height: SW * 1.3,
  },
});
