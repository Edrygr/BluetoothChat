# BluetoothChat v1.0.0

**Release date:** 2026-06-14

## What's included

This is the first release of BluetoothChat.

### Core features

- Peer-to-peer encrypted chat over BLE — no internet, no pairing required.
- X25519 key exchange + AES-256-GCM encryption + HMAC-SHA256 ratchet (forward secrecy).
- Short Authentication String (SAS) for out-of-band MITM verification.
- Image and video transfer (chunked, encrypted, sequential to avoid BLE stack saturation).
- Cover traffic to obscure communication patterns.
- Dual BLE role: each device acts as both GATT peripheral (advertiser) and central (scanner).

### Architecture highlights

- **BLE stack**: `react-native-ble-plx` for the central role; custom Kotlin `BlePeripheralModule` for the peripheral/GATT-server role.
- **Crypto**: pure `@noble` libraries — no native crypto bindings required.
- **Hermes-compatible**: no `Buffer`, no `TextEncoder`/`TextDecoder` — all codec work done in pure JS.
- **React Native 0.86** with the new architecture (`newArchEnabled=true`) and Hermes JS engine.

### How to install

1. Download `app-debug.apk` from this folder (if included) **or** build from source (see README).
2. Enable "Install from unknown sources" in Android settings.
3. Transfer the APK to your device and open it.
4. Grant Bluetooth and Location permissions when prompted.

---

## Known limitations

- Android only (no iOS support in this release).
- Debug build — not optimized for production.
- Transfer speed for large videos depends on BLE MTU and device hardware; typically 5–30 KB/s.
- No message persistence — chat history is lost when the app is closed.
