# FIX 01 (origin/main d449695) - OTP data & API access

## What changed

- Public `GET /api/lockers` excludes customer info and OTP. The admin key enables full data.
- History, reset and time-forward require `X-Admin-Key`.
- Device OTP verification and update/sensor API require `X-Device-Key` or admin key.
- OTPs are not logged to server/serial or sent through SSE.
- OTP attempts: 10 failures per IP in 15 minutes (in-memory only).
- Admin page `/admin.html` prompts for key, retained only in the JS memory.
- Existing upstream version already removed the fixed Master OTP, so there is no Master-key deletion in this patch.
- Firmware reads Wi-Fi and device API key from untracked `secrets.h`.

## Setup on Windows

1. Copy `secrets.example.bat` to `secrets.bat`. Replace both values with **different random secrets** each at least 16 chars. Keep `secrets.bat` secret.
2. Start server using `start_secure.example.bat` (or use `call secrets.bat` before `node server.js`). `npm start` without the environment variables will fail closed intentionally.
3. Copy `firmware/SmartLocker_ESP32/secrets.example.h` to `firmware/SmartLocker_ESP32/secrets.h` and provide the Wi-Fi SSID, password, your LAN server IP and the **same DEVICE key** as on the server.
4. Rebuild/reflash ESP32 *alongside* backend deployment; old ESP32 firmware cannot authenticate with the new backend.
5. Change the Wi-Fi password already exposed in the previous repository revisions / ZIP. Never commit secrets to GitHub.

## Checks

- `node --check server.js` and `node --check public/app.js`.
- `node --test tests/fix01.test.js` after `npm ci` (or `npm install`).
- Hardware ESP32 validation **not done**, and this patch is **not ready for production**.
- The HTTP LAN connection sends API keys without transport encryption. Use only on a trusted isolated LAN for the prototype. Before production use HTTPS/mTLS/VPN and persistent, better-scoped authentication.
- Does not yet prevent invalid `ITEM_STORED` / `ITEM_PICKED` transitions or ensure per-compartment sensors, to be addressed in FIX 02.
- Booking endpoint returns OTPs to the requester as intended; student/shipper identity is not verified by this prototype.
- This patch was prepared for d449695, not for arbitrary future commits. Check with `git apply --check` first.

## Git safety

- No changes to untracked `smart loker/`; do not delete it.
- Do not `git stash pop` into this new security branch before checking conflicts.
- The file `SmartLocker_FIX01.patch` itself should not be added to the commit.
