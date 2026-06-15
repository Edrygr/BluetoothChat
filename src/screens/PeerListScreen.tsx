import React, { useState } from 'react';
import {
  View,
  FlatList,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Alert,
  Modal,
  Clipboard,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useApp } from '../store/AppStore';
import { Peer } from '../types';
import type { RootStackParamList } from '../App';

type Nav = StackNavigationProp<RootStackParamList, 'PeerList'>;

export function PeerListScreen() {
  const { state } = useApp();
  const navigation = useNavigation<Nav>();
  const [sasPeer, setSasPeer] = useState<Peer | null>(null);

  function showSAS(peer: Peer) {
    setSasPeer(peer);
  }

  function openDM(peer: Peer) {
    navigation.navigate('DirectMessage', { peerId: peer.anonymousId });
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Peers in Mesh</Text>
      </View>

      <View style={styles.hint}>
        <Text style={styles.hintText}>
          Tap 🔑 to verify identity — compare the SAS code verbally with the other person.
          If they match, there is no man-in-the-middle.
        </Text>
      </View>

      <FlatList
        data={state.peers}
        keyExtractor={item => item.deviceId}
        renderItem={({ item }) => (
          <View style={styles.peerRow}>
            <TouchableOpacity style={styles.peerMain} onPress={() => openDM(item)}>
              <View style={[styles.avatar, { backgroundColor: colorFor(item.anonymousId) }]}>
                <Text style={styles.avatarText}>{item.anonymousId[0]}</Text>
              </View>
              <View style={styles.peerInfo}>
                <Text style={styles.peerName}>{item.anonymousId}</Text>
                <Text style={styles.peerSub}>Tap to open DM</Text>
              </View>
            </TouchableOpacity>

            {/* SAS verification button */}
            <TouchableOpacity style={styles.sasBtn} onPress={() => showSAS(item)}>
              <Text style={styles.sasBtnText}>🔑</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No peers connected yet.{'\n'}
            Make sure nearby devices have the app open with Bluetooth enabled.
          </Text>
        }
      />

      {/* SAS verification modal */}
      <Modal
        visible={!!sasPeer}
        transparent
        animationType="fade"
        onRequestClose={() => setSasPeer(null)}>
        <TouchableOpacity style={styles.modalBg} onPress={() => setSasPeer(null)}>
          <View style={styles.sasModal}>
            <Text style={styles.sasTitle}>Verify Identity</Text>
            <Text style={styles.sasSubtitle}>
              Ask <Text style={styles.sasPeerName}>{sasPeer?.anonymousId}</Text> to read their
              code and compare it with yours:
            </Text>

            <View style={styles.sasCodeBox}>
              <Text style={styles.sasCode}>{sasPeer?.sas}</Text>
            </View>

            <Text style={styles.sasExplain}>
              If the 3-byte code matches on both screens, your connection is secure — no
              man-in-the-middle intercepted the key exchange.
            </Text>

            <TouchableOpacity
              style={styles.sasDismiss}
              onPress={() => setSasPeer(null)}>
              <Text style={styles.sasDismissText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const COLORS = ['#0084ff', '#ff6b35', '#7c3aed', '#059669', '#dc2626', '#d97706'];
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i)) % COLORS.length;
  return COLORS[h];
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
    paddingVertical: 14,
    backgroundColor: '#1a1a1e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2e',
  },
  backBtn: { marginRight: 12 },
  backText: { color: '#0084ff', fontSize: 15 },
  title: { fontSize: 17, fontWeight: '700', color: '#fff' },
  hint: {
    backgroundColor: '#1e2a1e',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2e',
  },
  hintText: { color: '#5a9a5a', fontSize: 11, lineHeight: 16 },
  peerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e22',
  },
  peerMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  peerInfo: { flex: 1 },
  peerName: { color: '#f0f0f0', fontSize: 15, fontWeight: '600' },
  peerSub: { color: '#666', fontSize: 12, marginTop: 2 },
  sasBtn: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  sasBtnText: { fontSize: 22 },
  empty: {
    textAlign: 'center',
    color: '#555',
    marginTop: 80,
    fontSize: 14,
    lineHeight: 22,
    paddingHorizontal: 32,
  },
  // SAS modal
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  sasModal: {
    backgroundColor: '#1e1e22',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2d7a2d',
  },
  sasTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
  },
  sasSubtitle: {
    fontSize: 13,
    color: '#aaa',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 18,
  },
  sasPeerName: {
    color: '#0084ff',
    fontWeight: '600',
  },
  sasCodeBox: {
    backgroundColor: '#111114',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#2d7a2d',
  },
  sasCode: {
    fontSize: 36,
    fontWeight: '800',
    color: '#2d9a2d',
    letterSpacing: 6,
    fontFamily: 'monospace',
  },
  sasExplain: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    lineHeight: 17,
    marginBottom: 20,
  },
  sasDismiss: {
    backgroundColor: '#2a2a2e',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  sasDismissText: { color: '#f0f0f0', fontSize: 14, fontWeight: '600' },
});
