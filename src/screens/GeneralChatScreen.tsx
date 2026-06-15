import React, { useRef } from 'react';
import {
  View,
  FlatList,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useApp } from '../store/AppStore';
import { MessageBubble } from '../components/MessageBubble';
import { MessageInput } from '../components/MessageInput';
import { MediaKind } from '../types';
import type { RootStackParamList } from '../App';

type Nav = StackNavigationProp<RootStackParamList, 'GeneralChat'>;

export function GeneralChatScreen() {
  const { state, sendGeneral, sendMediaGeneral, panic } = useApp();
  const navigation = useNavigation<Nav>();
  const listRef = useRef<FlatList>(null);

  function handlePanic() {
    Alert.alert(
      '⚠️ Panic Wipe',
      'This will instantly disconnect all peers, destroy all encryption keys, and erase every message. Cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe Everything',
          style: 'destructive',
          onPress: panic,
        },
      ],
    );
  }

  const connectedCount = state.peers.length;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>General</Text>
          <Text style={styles.subtitle}>
            {connectedCount === 0
              ? 'Searching for peers…'
              : `${connectedCount} peer${connectedCount !== 1 ? 's' : ''} in mesh`}
          </Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.peersBtn}
            onPress={() => navigation.navigate('PeerList')}>
            <Text style={styles.peersBtnText}>👥 {connectedCount}</Text>
          </TouchableOpacity>

          {/* Panic button — long press to avoid accidental activation */}
          <TouchableOpacity
            style={styles.panicBtn}
            onLongPress={handlePanic}
            delayLongPress={800}>
            <Text style={styles.panicIcon}>🛑</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Identity badge */}
      <View style={styles.idBadge}>
        <Text style={styles.idText}>
          You: <Text style={styles.idName}>{state.selfId}</Text>
          {'  ·  '}
          <Text style={styles.encLabel}>AES-GCM · Ratchet</Text>
        </Text>
      </View>

      <FlatList
        ref={listRef}
        data={state.generalMessages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {connectedCount === 0
              ? 'Waiting for nearby devices with Bluetooth enabled…'
              : 'No messages yet. Say hello!'}
          </Text>
        }
      />

      <MessageInput
        onSendText={sendGeneral}
        onSendMedia={sendMediaGeneral}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#111114',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1a1a1e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2e',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  subtitle: {
    fontSize: 12,
    color: '#888',
    marginTop: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  peersBtn: {
    backgroundColor: '#2a2a2e',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  peersBtnText: {
    color: '#f0f0f0',
    fontSize: 14,
  },
  panicBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  panicIcon: {
    fontSize: 22,
  },
  idBadge: {
    backgroundColor: '#1e1e22',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2e',
  },
  idText: {
    color: '#666',
    fontSize: 11,
  },
  idName: {
    color: '#0084ff',
    fontWeight: '600',
  },
  encLabel: {
    color: '#2d7a2d',
    fontWeight: '500',
  },
  list: {
    paddingVertical: 8,
    flexGrow: 1,
  },
  empty: {
    textAlign: 'center',
    color: '#555',
    marginTop: 80,
    fontSize: 14,
    paddingHorizontal: 32,
    lineHeight: 22,
  },
});
