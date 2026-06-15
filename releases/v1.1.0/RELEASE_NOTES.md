# BluetoothChat v1.1.0 — Bug Fix Release

## What's Fixed

### Messaging reliability
- **Second message never arrived** — fixed two root causes:
  - `handleHandshake` was resetting both ratchets on every duplicate HANDSHAKE
    (proactive retry + peripheral reply both landing), desyncing seqNums and
    silently dropping all messages after the first.
  - Cover traffic was encrypting with the ratchet; the receiver ignored COVER
    packets without advancing its recv-ratchet, permanently desyncing seqNums
    after the first cover fire (~6 seconds).

### BLE notification corruption (malformed decodeURI)
- `notifyCharacteristicChanged` only *queues* the notification in Android's BLE
  stack — it does not wait for transmission. JS was resolving the promise
  immediately, allowing the next frame to overwrite `notifyChar.value` before
  Android transmitted the first one. A received the wrong bytes, causing
  `decodeURIComponent` to throw.
- **Fix:** `onNotificationSent` callback now drives promise resolution. A 5-second
  safety timeout rejects the promise if the BLE stack never fires the callback,
  preventing the write queue from hanging forever.

### B stops receiving after extended use
- When A exhausted write retries and dropped B from its app state, the physical
  BLE link stayed open. B never received a disconnect event, kept its old ratchet
  state, and rejected every message from A's fresh reconnect (seqNum=0 ≠ recvSeq=N).
- **Fix:** A now calls `cancelConnection()` after dropping B, forcing a clean OS-level
  disconnect so B clears its state. A also triggers an immediate rescan so
  reconnection happens in seconds rather than waiting up to 12 seconds.

### Consecutive messages stopping on slow devices
- Write retry window was 360ms (3 attempts, 120/240ms backoff) — too short for
  slow devices whose ATT acknowledgments take longer.
- **Fix:** Exponential backoff with 5 attempts (200 → 400 → 800 → 1600 → 3200ms,
  ~6s total) before dropping the peer.

### DM replay deduplication
- `handleDM` had no `seenIds` check, allowing relay nodes to advance the ratchet
  twice if a packet was replayed in mesh scenarios.

## New Features

### Support button
- Amber "Support" button added to both the General Chat and Peer List screens.
- Tapping shows crypto donation addresses (BTC, ETH, SOL, TRON, XRP).
- Tap any address to copy it to clipboard.

## Target
- Android 11+ (API 30) — devices 2–4 years old
- Minimum SDK unchanged; older devices may work but are not actively supported
