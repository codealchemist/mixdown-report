# yicam-bridge (ESP32)

This firmware turns a cheap ESP32 DevKit into a small motion-snapshot bridge for a Yi camera running [yi-hack-Allwinner](https://github.com/roleoroleo/yi-hack-Allwinner):

```
Yi camera ──MQTT motion_start/stop──▶ ESP32 (MQTT broker)
ESP32 ──HTTP GET /cgi-bin/snapshot.sh──▶ Yi camera      (JPEG → flash queue)
ESP32 ──HTTPS POST (base64 JPEG)──▶ Google Apps Script ──▶ Google Drive/YiCam/<date>/
```

- No PC needs to stay on, and nothing goes through Yi's cloud.
- Plain HTTP and MQTT never leave your LAN. The only traffic to the internet is the HTTPS upload, and the ESP32 verifies Google's certificate.
- Target board: ESP32 DevKit with the ESP-WROOM-32 module and CP2102 USB chip (no PSRAM). Images are streamed camera → flash → TLS, so they are never held whole in RAM.
- During a motion event the ESP32 takes a shot every `interval` seconds, up to `maxShots`, until `motion_stop`. The AI labels `human`, `vehicle` and `animal`, which the camera sends on the same topic, also count as motion.

## 1. Google Drive receiver (Apps Script)

1. Go to <https://script.google.com> and create a **New project**. Paste in [`apps-script/Code.gs`](apps-script/Code.gs).
2. Open **Project Settings → Script properties** and add:
   - `TOKEN`: a long random string, for example from `openssl rand -hex 24`.
   - Optional: `FOLDER_ID`. Images default to a `YiCam` folder in My Drive.
   - Optional: `RETENTION_DAYS`, the number of days of images to keep (default 30).
3. Click **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**. Authorize, then copy the `/exec` URL.
4. Optional: run `installCleanupTrigger` once to delete old day folders automatically.

Anyone who has both the URL and the token can upload to that folder, so keep them private.

## 2. Build & flash (on the computer the board is plugged into)

```bash
pip install platformio            # or: brew install platformio
cd yicam-esp32
pio run -e usb -t upload          # first flash over USB
pio device monitor                # serial log, 115200 baud
```

On macOS the CP2102 board usually appears as `/dev/cu.usbserial-*` or `/dev/cu.SLAB_USBtoUART`. If the upload stalls at `Connecting...`, hold the **IO0/BOOT** button until it starts.

## 3. First-boot setup portal

1. On first boot the ESP32 creates a Wi-Fi network named **`YiCam-Setup`**. Connect to it with the password `yicamsetup`.
2. A setup page opens; if it doesn't, browse to `192.168.4.1`. Fill in:
   - Your Wi-Fi network (2.4 GHz)
   - **Camera IP**, e.g. `192.168.0.163`
   - **Apps Script URL** and **token** from step 1
   - **MQTT user / password**: credentials the *camera* will use to connect to the ESP32. Leaving the user blank makes the broker open to anything on your LAN.
   - Resolution (`high` or `low`), seconds between shots, max shots per event, timezone (POSIX, default `<-03>3` = UTC-3), and an OTA password
3. Save. The board joins your Wi-Fi.

To reopen the portal later, press **EN** (reset) and hold **IO0/BOOT** during the first 2 seconds. Fields marked *secret* are never shown; leave them blank to keep the stored value.

Reserve a fixed IP for the ESP32 in your router (DHCP reservation), because the camera points at it.

## 4. Point the camera at the ESP32

In the yi-hack web UI (`http://192.168.0.163`), open **MQTT settings**:

| Setting | Value |
|---|---|
| MQTT | enabled |
| Broker IP | the ESP32's IP |
| Port | `1883` |
| User / password | the MQTT credentials from the portal |
| Prefix / motion topic | `yicam` / `motion_detection` (the defaults; must match the portal's *Motion topic*) |

Turn off "send image on motion" (`motion_detection_image`) if your build offers it. The ESP32 ignores that topic because it fetches snapshots itself.

## 5. Test

```bash
curl http://<esp32-ip>/status                 # JSON: counters, queue, last error
curl -X POST http://<esp32-ip>/snap           # take a test shot now
```

Then walk in front of the camera. Images should appear in Drive under `YiCam/<yyyy-mm-dd>/` within a few seconds.

## Updates over Wi-Fi

```bash
PLATFORMIO_UPLOAD_FLAGS="--auth=<ota-password>" pio run -e ota -t upload
```

## Notes & limits

- Storage: the queue holds about 3 high-res JPEGs. When it's full, new shots are skipped so the first shots of an event survive; check `dropped` in `/status`. If uploads can't keep up, use `low` resolution or a longer interval.
- The built-in broker is small. It handles the camera plus a couple of LAN clients (for example your own app subscribing to `yicam/#`) and doesn't store messages for offline clients.
- Uploads verify Google's TLS chain against GTS Root R1/R4 and GlobalSign ECC R4, which are embedded in `src/root_certs.h` and valid until 2036/2038.
