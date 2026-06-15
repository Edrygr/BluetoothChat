# BluetoothChat

A React Native Android app for **private, encrypted peer-to-peer chat over Bluetooth Low Energy (BLE)** — no internet, no server, no pairing required.

---

## Features

- **No pairing required** — connects to nearby devices without going through Android's system Bluetooth pairing dialog.
- **End-to-end encryption** — every message is encrypted with AES-256-GCM using ephemeral session keys derived via X25519 Diffie-Hellman.
- **Forward secrecy** — a symmetric HMAC-SHA256 ratchet advances after every message, so past messages stay safe if a key is ever exposed.
- **Short Authentication String (SAS)** — compare a 3-byte hex code with your peer out-of-band to verify there is no man-in-the-middle.
- **Media transfer** — send images and videos, chunked and encrypted, over BLE.
- **Cover traffic** — random dummy frames are injected to make traffic analysis harder.
- **No internet dependency** — works entirely offline, using BLE radio.
- **Dual BLE role** — each device advertises as a peripheral and scans as a central simultaneously, so either side can initiate a connection.

---

## Requirements

- Android 8.0 (API 26) or higher
- Android 11+ recommended (for better BLE throughput)
- Bluetooth Low Energy hardware (all modern Android phones have this)
- Location permission (required by Android for BLE scanning)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native 0.86 + Hermes JS engine |
| BLE Central | `react-native-ble-plx` v3 |
| BLE Peripheral | Custom Kotlin native module (`BlePeripheralModule`) |
| Crypto | `@noble/curves` (X25519), `@noble/ciphers` (AES-GCM), `@noble/hashes` (HMAC-SHA256) |
| Navigation | React Navigation v7 |
| Media | `react-native-image-picker`, `react-native-fs`, `react-native-video` |

---

## How It Works

### Connection

1. Both devices advertise a custom BLE GATT service (`A1234567-89AB-CDEF-0123-456789ABCDEF`).
2. Each device also scans for that service UUID.
3. When a scanner finds an advertiser, it connects as GATT central and subscribes to the RX characteristic for notifications.
4. The GATT server (peripheral side) detects the connection and enables notifications via the CCCD descriptor.
5. Messages travel in both directions: central writes to the TX characteristic; peripheral notifies via the RX characteristic.

### Key Exchange

1. On connection, both peers send a `HELLO` packet containing an ephemeral X25519 public key.
2. Each side computes the shared secret via ECDH: `sharedSecret = X25519(myPrivate, theirPublic)`.
3. A symmetric ratchet is initialized from the shared secret.

### Encryption

Each message is encrypted with a one-time key derived from the ratchet:
```
messageKey = HMAC-SHA256(chainKey, 0x01)
chainKey   = HMAC-SHA256(chainKey, 0x02)
ciphertext = AES-256-GCM(messageKey, nonce, plaintext)
```
The nonce is random 12 bytes. The GCM authentication tag detects any tampering.

### Framing

BLE MTU limits data per write. Long messages are split into 490-character frames with a 6-character hex header:
```
[seqId(2 hex)][chunkIdx(2 hex)][totalChunks(2 hex)][payload up to 490 chars]
```
The receiver reassembles frames by sequence ID before parsing.

### Media Transfer

Images and videos are base64-encoded, split into chunks, and sent as a sequence of `MEDIA_START` → `MEDIA_CHUNK` × N → `MEDIA_END` packets. Each chunk is individually encrypted. The sender awaits the BLE write ACK after each chunk to avoid overwhelming the BLE stack.

---

## Build & Install

### Prerequisites

- Node.js >= 22
- Java 17 (JDK)
- Android SDK (API 35 build tools)
- `adb` in PATH

### Steps

```bash
# 1. Install JS dependencies
npm install

# 2. Generate the JS bundle
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res

# 3. Build the APK
cd android && ./gradlew assembleDebug

# 4. Install on connected device
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## Project Structure

```
BluetoothChat/
├── src/
│   ├── bluetooth/
│   │   ├── BluetoothService.ts   # BLE connection, framing, send/receive logic
│   │   └── Protocol.ts           # Packet types and chunk sizes
│   ├── crypto/
│   │   └── CryptoService.ts      # X25519, AES-GCM, ratchet, SAS
│   └── screens/                  # React Native UI screens
├── android/
│   └── app/src/main/java/com/bluetoothchat/
│       ├── BlePeripheralModule.kt  # Native GATT server + BLE advertising
│       └── BlePeripheralPackage.kt # Registers native module
└── index.js                        # App entry point
```

---

## Security Notes

- Keys are ephemeral (generated at connection time, never stored).
- The SAS verification step is optional but highly recommended to prevent MITM attacks.
- Cover traffic is on by default to obscure communication patterns.
- This app has not undergone a formal security audit. Do not rely on it for life-critical communications.

---

## License

MIT

---
---

# BluetoothChat (Español)

Aplicación Android de React Native para **chat privado y cifrado entre pares mediante Bluetooth Low Energy (BLE)** — sin internet, sin servidor, sin necesidad de emparejar dispositivos.

---

## Características

- **Sin emparejamiento previo** — se conecta a dispositivos cercanos sin necesidad de pasar por el diálogo de emparejamiento Bluetooth del sistema Android.
- **Cifrado de extremo a extremo** — cada mensaje se cifra con AES-256-GCM usando claves de sesión efímeras derivadas mediante X25519 Diffie-Hellman.
- **Secreto hacia adelante (forward secrecy)** — un ratchet simétrico HMAC-SHA256 avanza tras cada mensaje, de modo que los mensajes pasados permanecen protegidos aunque alguna clave quede expuesta en el futuro.
- **Cadena de autenticación corta (SAS)** — compara un código hexadecimal de 3 bytes con tu par fuera de banda para verificar que no hay ningún intermediario malicioso.
- **Transferencia de medios** — envía imágenes y vídeos, divididos en fragmentos y cifrados, a través de BLE.
- **Tráfico de cobertura** — se inyectan tramas ficticias aleatorias para dificultar el análisis de tráfico.
- **Sin dependencia de internet** — funciona completamente sin conexión, usando la radio BLE.
- **Doble rol BLE** — cada dispositivo actúa simultáneamente como periférico (anuncia su presencia) y como central (escanea), por lo que cualquiera de los dos puede iniciar la conexión.

---

## Requisitos

- Android 8.0 (API 26) o superior
- Se recomienda Android 11+ (para mejor rendimiento BLE)
- Hardware Bluetooth Low Energy (todos los teléfonos Android modernos lo tienen)
- Permiso de ubicación (requerido por Android para el escaneo BLE)

---

## Tecnologías utilizadas

| Capa | Tecnología |
|---|---|
| Framework | React Native 0.86 + motor JS Hermes |
| BLE Central | `react-native-ble-plx` v3 |
| BLE Periférico | Módulo nativo Kotlin personalizado (`BlePeripheralModule`) |
| Criptografía | `@noble/curves` (X25519), `@noble/ciphers` (AES-GCM), `@noble/hashes` (HMAC-SHA256) |
| Navegación | React Navigation v7 |
| Medios | `react-native-image-picker`, `react-native-fs`, `react-native-video` |

---

## Cómo funciona

### Conexión

1. Ambos dispositivos anuncian un servicio GATT BLE personalizado (`A1234567-89AB-CDEF-0123-456789ABCDEF`).
2. Cada dispositivo también escanea ese UUID de servicio.
3. Cuando el escáner encuentra al anunciante, se conecta como central GATT y se suscribe a la característica RX para recibir notificaciones.
4. El servidor GATT (lado periférico) detecta la conexión y habilita las notificaciones mediante el descriptor CCCD.
5. Los mensajes viajan en ambas direcciones: el central escribe en la característica TX; el periférico notifica a través de la característica RX.

### Intercambio de claves

1. Al conectarse, ambos pares envían un paquete `HELLO` con una clave pública X25519 efímera.
2. Cada lado calcula el secreto compartido mediante ECDH: `secretoCompartido = X25519(miPrivada, suPublica)`.
3. Se inicializa un ratchet simétrico a partir del secreto compartido.

### Cifrado

Cada mensaje se cifra con una clave de un solo uso derivada del ratchet:
```
claveMensaje = HMAC-SHA256(claveChain, 0x01)
claveChain   = HMAC-SHA256(claveChain, 0x02)
textoCifrado = AES-256-GCM(claveMensaje, nonce, textoPlano)
```
El nonce son 12 bytes aleatorios. La etiqueta de autenticación GCM detecta cualquier manipulación.

### Fragmentación (Framing)

El MTU de BLE limita los datos por escritura. Los mensajes largos se dividen en tramas de hasta 490 caracteres con una cabecera hexadecimal de 6 caracteres:
```
[seqId(2 hex)][chunkIdx(2 hex)][totalChunks(2 hex)][payload hasta 490 chars]
```
El receptor reensambla las tramas por ID de secuencia antes de parsearlas.

### Transferencia de medios

Las imágenes y vídeos se codifican en base64, se dividen en fragmentos y se envían como una secuencia de paquetes `MEDIA_START` → `MEDIA_CHUNK` × N → `MEDIA_END`. Cada fragmento se cifra individualmente. El emisor espera el ACK de escritura BLE tras cada fragmento para no saturar la pila BLE.

---

## Compilar e instalar

### Requisitos previos

- Node.js >= 22
- Java 17 (JDK)
- Android SDK (API 35 build tools)
- `adb` en el PATH

### Pasos

```bash
# 1. Instalar dependencias JS
npm install

# 2. Generar el bundle JS
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res

# 3. Compilar el APK
cd android && ./gradlew assembleDebug

# 4. Instalar en el dispositivo conectado
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## Estructura del proyecto

```
BluetoothChat/
├── src/
│   ├── bluetooth/
│   │   ├── BluetoothService.ts   # Conexión BLE, fragmentación, lógica de envío/recepción
│   │   └── Protocol.ts           # Tipos de paquetes y tamaños de fragmentos
│   ├── crypto/
│   │   └── CryptoService.ts      # X25519, AES-GCM, ratchet, SAS
│   └── screens/                  # Pantallas de la interfaz React Native
├── android/
│   └── app/src/main/java/com/bluetoothchat/
│       ├── BlePeripheralModule.kt  # Servidor GATT nativo + publicidad BLE
│       └── BlePeripheralPackage.kt # Registra el módulo nativo
└── index.js                        # Punto de entrada de la app
```

---

## Notas de seguridad

- Las claves son efímeras (se generan al conectarse, nunca se almacenan).
- La verificación SAS es opcional, pero muy recomendable para prevenir ataques de intermediario (MITM).
- El tráfico de cobertura está activado por defecto para ocultar los patrones de comunicación.
- Esta aplicación no ha sido sometida a una auditoría de seguridad formal. No la uses para comunicaciones de carácter crítico.

---

## Licencia

MIT
