import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './store/AppStore';
import { GeneralChatScreen } from './screens/GeneralChatScreen';
import { DirectMessageScreen } from './screens/DirectMessageScreen';
import { PeerListScreen } from './screens/PeerListScreen';

export type RootStackParamList = {
  GeneralChat: undefined;
  PeerList: undefined;
  DirectMessage: { peerId: string };
};

const Stack = createStackNavigator<RootStackParamList>();

function AppNavigator() {
  const { state } = useApp();

  if (!state.isReady) {
    return (
      <View style={styles.loading}>
        {state.error ? (
          <>
            <Text style={styles.errorTitle}>Bluetooth Error</Text>
            <Text style={styles.errorText}>{state.error}</Text>
            <Text style={styles.errorHint}>
              Make sure Bluetooth is enabled and the app has the required permissions.
            </Text>
          </>
        ) : (
          <>
            <ActivityIndicator color="#0084ff" size="large" />
            <Text style={styles.loadingText}>Starting Bluetooth mesh…</Text>
          </>
        )}
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="GeneralChat" component={GeneralChatScreen} />
        <Stack.Screen name="PeerList" component={PeerListScreen} />
        <Stack.Screen name="DirectMessage" component={DirectMessageScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <AppNavigator />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#111114',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    color: '#888',
    marginTop: 16,
    fontSize: 14,
  },
  errorTitle: {
    color: '#ff4444',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  errorText: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  errorHint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
});
