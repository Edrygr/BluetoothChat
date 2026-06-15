import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, ScrollView,
  Alert, Clipboard, StyleSheet,
} from 'react-native';

const ADDRESSES = [
  { label: 'Bitcoin (BTC)',    symbol: '₿', address: 'bc1qme596c7vuaeh3rpsg88mj8fq6n6gkqawwe2te2' },
  { label: 'Ethereum (ETH)',   symbol: 'Ξ', address: '0x4B3EFbb2C520C2423435b0E59351EecF43FBBD60' },
  { label: 'Solana (SOL)',     symbol: '◎', address: '9rZoBAUWrTMjyDpbYanXu2mBsqznFGnEYHyUqG8XAbgX' },
  { label: 'TRON (TRX/USDT)', symbol: 'T', address: 'TEAe1kK5poxZigqcoKKU4gRWsS1EsK5V5t' },
  { label: 'Ripple (XRP)',     symbol: 'X', address: 'r9EUW92eA5gnRHqrg6TmpSfherGyYuwT61' },
];

export function DonateButton() {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <TouchableOpacity style={s.btn} onPress={() => setVisible(true)}>
        <Text style={s.btnText}>Support</Text>
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={() => setVisible(false)}>
        <TouchableOpacity
          style={s.bg}
          activeOpacity={1}
          onPress={() => setVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={s.modal}>
            <Text style={s.title}>Support the Project</Text>
            <Text style={s.subtitle}>
              BluetoothChat is free and open-source.{'\n'}
              If you find it useful, consider donating.{'\n'}
              Tap an address to copy it.
            </Text>
            <ScrollView style={s.list} showsVerticalScrollIndicator={false}>
              {ADDRESSES.map(item => (
                <TouchableOpacity
                  key={item.address}
                  style={s.row}
                  onPress={() => {
                    Clipboard.setString(item.address);
                    Alert.alert('Copied', `${item.label} address copied to clipboard.`);
                  }}>
                  <View style={s.badge}>
                    <Text style={s.symbol}>{item.symbol}</Text>
                  </View>
                  <View style={s.info}>
                    <Text style={s.addrLabel}>{item.label}</Text>
                    <Text style={s.addr} numberOfLines={1} ellipsizeMode="middle">
                      {item.address}
                    </Text>
                  </View>
                  <Text style={s.copy}>⎘</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.close} onPress={() => setVisible(false)}>
              <Text style={s.closeText}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  btn: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  btnText: { color: '#1a1200', fontSize: 12, fontWeight: '700' },
  bg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modal: {
    backgroundColor: '#1a1a1e',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: '#f59e0b44',
    alignItems: 'center',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#f59e0b', marginBottom: 8 },
  subtitle: { fontSize: 12, color: '#888', textAlign: 'center', marginBottom: 16, lineHeight: 18 },
  list: { width: '100%', marginBottom: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111114',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2a2a2e',
  },
  badge: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#2a2a0a',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 10,
    borderWidth: 1, borderColor: '#f59e0b55',
  },
  symbol: { color: '#f59e0b', fontSize: 16, fontWeight: '800' },
  info: { flex: 1 },
  addrLabel: { color: '#ccc', fontSize: 13, fontWeight: '600', marginBottom: 2 },
  addr: { color: '#666', fontSize: 11, fontFamily: 'monospace' },
  copy: { color: '#f59e0b', fontSize: 18, marginLeft: 8 },
  close: {
    backgroundColor: '#2a2a2e',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  closeText: { color: '#f0f0f0', fontSize: 14, fontWeight: '600' },
});
