import React, { useRef } from 'react';
import {
  View,
  FlatList,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useApp } from '../store/AppStore';
import { MessageBubble } from '../components/MessageBubble';
import { MessageInput } from '../components/MessageInput';
import { MediaKind } from '../types';
import type { RootStackParamList } from '../App';

type Route = RouteProp<RootStackParamList, 'DirectMessage'>;
type Nav = StackNavigationProp<RootStackParamList, 'DirectMessage'>;

export function DirectMessageScreen() {
  const { state, sendDM, sendMediaDM } = useApp();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { peerId } = route.params;
  const listRef = useRef<FlatList>(null);

  const messages = state.dmMessages[peerId] ?? [];

  function handleSendText(text: string) {
    sendDM(peerId, text);
  }

  async function handleSendMedia(localUri: string, mediaKind: MediaKind, mimeType: string) {
    await sendMediaDM(peerId, localUri, mediaKind, mimeType);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>{peerId}</Text>
          <Text style={styles.subtitle}>Direct Message · encrypted</Text>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>Start a private conversation with {peerId}</Text>
        }
      />

      <MessageInput onSendText={handleSendText} onSendMedia={handleSendMedia} />
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1a1a1e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2e',
  },
  backBtn: {
    marginRight: 14,
  },
  backText: {
    color: '#0084ff',
    fontSize: 20,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  subtitle: {
    fontSize: 11,
    color: '#0084ff',
    marginTop: 1,
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
  },
});
