// yicam-bridge: ESP32 MQTT broker that turns Yi camera (yi-hack) motion
// events into JPEG snapshots uploaded to Google Drive via an Apps Script.
//
// Flow:
//   camera --MQTT motion_start/stop--> ESP32 broker
//   ESP32 --HTTP GET /cgi-bin/snapshot.sh--> camera   (saved to LittleFS queue)
//   ESP32 --HTTPS POST base64 JPEG--> Apps Script web app --> Drive folder
//
// Target: classic ESP32 (ESP-WROOM-32) without PSRAM. Images never live fully
// in RAM: they are streamed camera -> flash -> (base64) -> TLS socket.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ArduinoOTA.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFiManager.h>
#include <PicoMQTT.h>
#include <time.h>

#include "root_certs.h"

static const char *FW_VERSION = "0.1.0";
static const char *HOSTNAME = "yicam-bridge";
static const char *SETUP_AP_NAME = "YiCam-Setup";
static const char *SETUP_AP_PASS = "yicamsetup";  // 8+ chars required by WPA2
static const int BOOT_BUTTON_PIN = 0;             // "IO0"/BOOT button
static const int LED_PIN = 2;                     // blue LED on most DevKits
static const char *QUEUE_DIR = "/q";
static const size_t MIN_FREE_BYTES = 320 * 1024;  // room for one high-res JPEG
static const uint32_t MOTION_FAILSAFE_MS = 5UL * 60UL * 1000UL;
static const uint32_t UPLOAD_RETRY_MS = 30UL * 1000UL;

// ---------------------------------------------------------------------------
// Configuration (stored in NVS, edited in the setup portal)
// ---------------------------------------------------------------------------
struct Config {
  String camHost = "192.168.0.163";
  String camUser;  // optional HTTP basic auth of the yi-hack web UI
  String camPass;
  String res = "high";  // high | low
  String scriptUrl;     // https://script.google.com/macros/s/.../exec
  String token;         // shared secret checked by the Apps Script
  String mqttUser;      // credentials the camera uses to connect to us
  String mqttPass;
  String motionTopic = "yicam/motion_detection";
  uint32_t intervalSec = 2;
  uint32_t maxShots = 10;
  String tz = "<-03>3";  // POSIX TZ, UTC-3
  String otaPass;
} cfg;

Preferences prefs;

void loadConfig() {
  prefs.begin("yicam", true);
  cfg.camHost = prefs.getString("camHost", cfg.camHost);
  cfg.camUser = prefs.getString("camUser", cfg.camUser);
  cfg.camPass = prefs.getString("camPass", cfg.camPass);
  cfg.res = prefs.getString("res", cfg.res);
  cfg.scriptUrl = prefs.getString("scriptUrl", cfg.scriptUrl);
  cfg.token = prefs.getString("token", cfg.token);
  cfg.mqttUser = prefs.getString("mqttUser", cfg.mqttUser);
  cfg.mqttPass = prefs.getString("mqttPass", cfg.mqttPass);
  cfg.motionTopic = prefs.getString("topic", cfg.motionTopic);
  cfg.intervalSec = prefs.getUInt("interval", cfg.intervalSec);
  cfg.maxShots = prefs.getUInt("maxShots", cfg.maxShots);
  cfg.tz = prefs.getString("tz", cfg.tz);
  cfg.otaPass = prefs.getString("otaPass", cfg.otaPass);
  prefs.end();
  if (cfg.intervalSec < 1) cfg.intervalSec = 1;
  if (cfg.maxShots < 1) cfg.maxShots = 1;
  if (cfg.res != "low") cfg.res = "high";
}

void saveConfig() {
  prefs.begin("yicam", false);
  prefs.putString("camHost", cfg.camHost);
  prefs.putString("camUser", cfg.camUser);
  prefs.putString("camPass", cfg.camPass);
  prefs.putString("res", cfg.res);
  prefs.putString("scriptUrl", cfg.scriptUrl);
  prefs.putString("token", cfg.token);
  prefs.putString("mqttUser", cfg.mqttUser);
  prefs.putString("mqttPass", cfg.mqttPass);
  prefs.putString("topic", cfg.motionTopic);
  prefs.putUInt("interval", cfg.intervalSec);
  prefs.putUInt("maxShots", cfg.maxShots);
  prefs.putString("tz", cfg.tz);
  prefs.putString("otaPass", cfg.otaPass);
  prefs.end();
}

// ---------------------------------------------------------------------------
// Shared state between the MQTT/web loop and the worker task
// ---------------------------------------------------------------------------
volatile bool motionActive = false;
volatile bool newMotionEvent = false;
volatile bool manualShot = false;
volatile uint32_t motionSinceMs = 0;

volatile uint32_t statEvents = 0, statCaptured = 0, statCaptureFail = 0,
                  statUploaded = 0, statUploadFail = 0, statDropped = 0,
                  statQueue = 0;
String lastError;  // written by worker only, read for status page
portMUX_TYPE errMux = portMUX_INITIALIZER_UNLOCKED;

void setError(const String &e) {
  Serial.println("[err] " + e);
  portENTER_CRITICAL(&errMux);
  lastError = e;
  portEXIT_CRITICAL(&errMux);
}

// ---------------------------------------------------------------------------
// MQTT broker
// ---------------------------------------------------------------------------
class Broker : public PicoMQTT::Server {
 protected:
  PicoMQTT::ConnectReturnCode auth(const char *client_id, const char *username,
                                   const char *password) override {
    if (cfg.mqttUser.isEmpty()) return PicoMQTT::CRC_ACCEPTED;  // open (LAN)
    if (username && password && cfg.mqttUser == username &&
        cfg.mqttPass == password)
      return PicoMQTT::CRC_ACCEPTED;
    Serial.printf("[mqtt] rejected client %s\n", client_id);
    return PicoMQTT::CRC_BAD_USERNAME_OR_PASSWORD;
  }
  void on_connected(const char *client_id) override {
    Serial.printf("[mqtt] client connected: %s\n", client_id);
  }
  void on_disconnected(const char *client_id) override {
    Serial.printf("[mqtt] client disconnected: %s\n", client_id);
  }
} mqtt;

void onMotionMessage(const char *payload) {
  String p(payload);
  p.trim();
  Serial.printf("[mqtt] %s = %s\n", cfg.motionTopic.c_str(), p.c_str());
  if (p == "motion_stop") {
    motionActive = false;
  } else if (p.length()) {
    // motion_start, or AI labels (human / vehicle / animal) on the same topic
    if (!motionActive) {
      newMotionEvent = true;
      statEvents++;
    }
    motionSinceMs = millis();
    motionActive = true;
  }
}

// ---------------------------------------------------------------------------
// Queue on LittleFS
// ---------------------------------------------------------------------------
String oldestQueued(size_t *count) {
  String oldest;
  size_t n = 0;
  File dir = LittleFS.open(QUEUE_DIR);
  if (!dir) return oldest;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    String name = f.name();  // basename on arduino-esp32 2.x
    f.close();
    if (!name.endsWith(".jpg")) continue;
    n++;
    if (oldest.isEmpty() || name < oldest) oldest = name;  // names sort by time
  }
  dir.close();
  if (count) *count = n;
  return oldest.isEmpty() ? oldest : String(QUEUE_DIR) + "/" + oldest;
}

bool hasSpaceForShot() {
  // Keep the first shots of an event: when the queue is full, skip new
  // captures instead of deleting older (unsent) ones.
  return LittleFS.totalBytes() - LittleFS.usedBytes() >= MIN_FREE_BYTES;
}

String timestampName(uint32_t seq) {
  char buf[48];
  time_t now = time(nullptr);
  if (now > 1700000000) {  // NTP synced
    struct tm t;
    localtime_r(&now, &t);
    snprintf(buf, sizeof(buf), "%04d%02d%02d-%02d%02d%02d-%02u.jpg",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min,
             t.tm_sec, (unsigned)(seq % 100));
  } else {
    snprintf(buf, sizeof(buf), "notime-%010lu-%02u.jpg",
             (unsigned long)millis(), (unsigned)(seq % 100));
  }
  return String(buf);
}

// ---------------------------------------------------------------------------
// Capture: camera snapshot -> LittleFS
// ---------------------------------------------------------------------------
bool captureSnapshot(uint32_t seq) {
  if (!hasSpaceForShot()) {
    statDropped++;
    setError("capture: queue full, shot skipped");
    return false;
  }
  String path = String(QUEUE_DIR) + "/" + timestampName(seq);
  String tmp = String(QUEUE_DIR) + "/partial.tmp";
  String url = "http://" + cfg.camHost +
               "/cgi-bin/snapshot.sh?res=" + cfg.res + "&watermark=yes";

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(15000);
  http.setConnectTimeout(5000);
  http.setReuse(false);
  if (!http.begin(client, url)) {
    setError("capture: bad URL " + url);
    return false;
  }
  if (cfg.camUser.length()) http.setAuthorization(cfg.camUser.c_str(), cfg.camPass.c_str());
  const char *hdrs[] = {"Content-Type"};
  http.collectHeaders(hdrs, 1);

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    setError("capture: HTTP " + String(code) + " " + http.errorToString(code));
    http.end();
    return false;
  }
  if (!http.header("Content-Type").startsWith("image/jpeg")) {
    setError("capture: unexpected content type " + http.header("Content-Type"));
    http.end();
    return false;
  }

  File f = LittleFS.open(tmp, FILE_WRITE);
  if (!f) {
    setError("capture: cannot open " + tmp);
    http.end();
    return false;
  }
  // No Content-Length from the CGI: writeToStream reads until the camera
  // closes the connection.
  int written = http.writeToStream(&f);
  f.close();
  http.end();

  bool ok = written > 2048;
  if (ok) {  // sanity check JPEG SOI marker
    File chk = LittleFS.open(tmp, FILE_READ);
    ok = chk && chk.read() == 0xFF && chk.read() == 0xD8;
    chk.close();
  }
  if (!ok) {
    setError("capture: invalid image (" + String(written) + " bytes)");
    LittleFS.remove(tmp);
    return false;
  }
  LittleFS.rename(tmp, path);
  Serial.printf("[capture] %s (%d bytes)\n", path.c_str(), written);
  return true;
}

// ---------------------------------------------------------------------------
// Upload: LittleFS -> base64 -> HTTPS POST to Apps Script
// ---------------------------------------------------------------------------
static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t b64encode(const uint8_t *in, size_t len, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < len) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < len) v |= in[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = i + 1 < len ? B64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < len ? B64[v & 63] : '=';
  }
  return o;
}

String urlEncode(const String &s) {
  String out;
  const char *hex = "0123456789ABCDEF";
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += c;
    } else {
      out += '%';
      out += hex[(c >> 4) & 15];
      out += hex[c & 15];
    }
  }
  return out;
}

bool splitHttpsUrl(const String &url, String &host, String &path) {
  if (!url.startsWith("https://")) return false;
  int slash = url.indexOf('/', 8);
  host = slash < 0 ? url.substring(8) : url.substring(8, slash);
  path = slash < 0 ? "/" : url.substring(slash);
  return host.length() > 0;
}

// Reads the status line and headers; returns status code, fills location.
int readResponseHead(WiFiClientSecure &c, String &location) {
  uint32_t deadline = millis() + 30000;
  while (!c.available() && c.connected() && millis() < deadline) delay(10);
  String status = c.readStringUntil('\n');
  int code = 0;
  int sp = status.indexOf(' ');
  if (sp > 0) code = status.substring(sp + 1, sp + 4).toInt();
  while (c.connected() || c.available()) {
    String line = c.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) break;
    if (line.substring(0, 9).equalsIgnoreCase("location:")) {
      location = line.substring(9);
      location.trim();
    }
  }
  return code;
}

bool uploadFile(const String &path) {
  if (cfg.scriptUrl.isEmpty()) {
    setError("upload: Apps Script URL not configured");
    return false;
  }
  String host, basePath;
  if (!splitHttpsUrl(cfg.scriptUrl, host, basePath)) {
    setError("upload: script URL must start with https://");
    return false;
  }

  File f = LittleFS.open(path, FILE_READ);
  if (!f) {
    setError("upload: cannot open " + path);
    return false;
  }
  size_t rawLen = f.size();
  size_t b64Len = 4 * ((rawLen + 2) / 3);
  String name = path.substring(path.lastIndexOf('/') + 1);
  String reqPath = basePath + (basePath.indexOf('?') >= 0 ? "&" : "?") +
                   "token=" + urlEncode(cfg.token) + "&name=" + urlEncode(name);

  WiFiClientSecure tls;
  tls.setCACert(GOOGLE_ROOT_CAS);
  tls.setTimeout(30);  // seconds
  if (!tls.connect(host.c_str(), 443)) {
    char err[100] = {0};
    tls.lastError(err, sizeof(err));
    setError("upload: TLS connect to " + host + " failed: " + err);
    f.close();
    return false;
  }

  tls.print("POST " + reqPath + " HTTP/1.1\r\n");
  tls.print("Host: " + host + "\r\n");
  tls.print("User-Agent: yicam-bridge/" + String(FW_VERSION) + "\r\n");
  tls.print("Content-Type: text/plain\r\n");
  tls.print("Content-Length: " + String(b64Len) + "\r\n");
  tls.print("Connection: close\r\n\r\n");

  static uint8_t raw[1536];  // multiple of 3 so chunks encode without padding
  static char enc[2048];
  size_t sent = 0;
  while (f.available()) {
    size_t n = f.read(raw, sizeof(raw));
    if (n == 0) break;
    size_t m = b64encode(raw, n, enc);
    if (tls.write((const uint8_t *)enc, m) != m) {
      setError("upload: write failed after " + String(sent) + " bytes");
      f.close();
      tls.stop();
      return false;
    }
    sent += m;
  }
  f.close();

  String location;
  int code = readResponseHead(tls, location);
  String body;
  if (code == 200) body = tls.readString();
  tls.stop();

  // Apps Script answers a POST with 302 -> script.googleusercontent.com,
  // where the doPost() JSON result can be read with a GET.
  if (code == 302 && location.startsWith("https://")) {
    WiFiClientSecure tls2;
    tls2.setCACert(GOOGLE_ROOT_CAS);
    HTTPClient http;
    http.setTimeout(20000);
    if (http.begin(tls2, location)) {
      int c2 = http.GET();
      if (c2 == HTTP_CODE_OK) {
        body = http.getString();
      } else {
        // doPost already ran; we just could not read its result.
        Serial.printf("[upload] result fetch HTTP %d, assuming success\n", c2);
        body = "{\"ok\":true}";
      }
      http.end();
    }
  }

  if (body.indexOf("\"ok\":true") >= 0) {
    Serial.printf("[upload] %s -> Drive (%u bytes)\n", name.c_str(), (unsigned)rawLen);
    return true;
  }
  setError("upload: HTTP " + String(code) + " " + body.substring(0, 160));
  return false;
}

// ---------------------------------------------------------------------------
// Worker task: captures during motion, drains the upload queue
// ---------------------------------------------------------------------------
void workerTask(void *) {
  uint32_t shotsThisEvent = 0, seq = 0;
  uint32_t lastShotMs = 0, nextUploadMs = 0;

  for (;;) {
    uint32_t now = millis();

    if (newMotionEvent) {
      newMotionEvent = false;
      shotsThisEvent = 0;
      lastShotMs = 0;
    }
    if (motionActive && now - motionSinceMs > MOTION_FAILSAFE_MS) {
      Serial.println("[motion] no motion_stop received, ending event");
      motionActive = false;
    }

    bool dueMotion = motionActive && shotsThisEvent < cfg.maxShots &&
                     (lastShotMs == 0 || now - lastShotMs >= cfg.intervalSec * 1000UL);
    if (manualShot || dueMotion) {
      if (dueMotion) {
        shotsThisEvent++;
        lastShotMs = now;
      }
      manualShot = false;
      if (captureSnapshot(seq++)) {
        statCaptured++;
        nextUploadMs = 0;  // try uploading right away
      } else {
        statCaptureFail++;
      }
    }

    size_t queued = 0;
    String next = oldestQueued(&queued);
    statQueue = queued;
    // Prefer capturing over uploading while an event is producing shots.
    bool captureSoon = motionActive && shotsThisEvent < cfg.maxShots &&
                       millis() - lastShotMs + 1500 >= cfg.intervalSec * 1000UL;
    if (!next.isEmpty() && !captureSoon && millis() >= nextUploadMs &&
        WiFi.isConnected()) {
      digitalWrite(LED_PIN, HIGH);
      if (uploadFile(next)) {
        LittleFS.remove(next);
        statUploaded++;
      } else {
        statUploadFail++;
        nextUploadMs = millis() + UPLOAD_RETRY_MS;
      }
      digitalWrite(LED_PIN, LOW);
    }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ---------------------------------------------------------------------------
// Setup portal (WiFiManager)
// ---------------------------------------------------------------------------
bool portalSaved = false;

void runWiFiSetup(bool forcePortal) {
  WiFiManager wm;
  char interval[8], maxShots[8];
  snprintf(interval, sizeof(interval), "%u", (unsigned)cfg.intervalSec);
  snprintf(maxShots, sizeof(maxShots), "%u", (unsigned)cfg.maxShots);

  // Secrets are never pre-filled; leave blank to keep the stored value.
  WiFiManagerParameter pHdr("<h3>YiCam bridge</h3><p>Leave secret fields blank to keep current values.</p>");
  WiFiManagerParameter pCam("camHost", "Camera IP / host", cfg.camHost.c_str(), 64);
  WiFiManagerParameter pCamUser("camUser", "Camera web user (optional)", cfg.camUser.c_str(), 32);
  WiFiManagerParameter pCamPass("camPass", "Camera web password (secret)", "", 64, "type='password'");
  WiFiManagerParameter pRes("res", "Snapshot resolution (high/low)", cfg.res.c_str(), 5);
  WiFiManagerParameter pUrl("scriptUrl", "Apps Script web app URL", cfg.scriptUrl.c_str(), 200);
  WiFiManagerParameter pToken("token", "Apps Script token (secret)", "", 64, "type='password'");
  WiFiManagerParameter pMUser("mqttUser", "MQTT user for the camera (blank = open)", cfg.mqttUser.c_str(), 32);
  WiFiManagerParameter pMPass("mqttPass", "MQTT password (secret)", "", 64, "type='password'");
  WiFiManagerParameter pTopic("topic", "Motion topic", cfg.motionTopic.c_str(), 96);
  WiFiManagerParameter pInt("interval", "Seconds between shots", interval, 6);
  WiFiManagerParameter pMax("maxShots", "Max shots per motion event", maxShots, 6);
  WiFiManagerParameter pTz("tz", "POSIX timezone", cfg.tz.c_str(), 48);
  WiFiManagerParameter pOta("otaPass", "OTA update password (secret)", "", 64, "type='password'");

  WiFiManagerParameter *params[] = {&pHdr, &pCam, &pCamUser, &pCamPass, &pRes,
                                    &pUrl, &pToken, &pMUser, &pMPass, &pTopic,
                                    &pInt, &pMax, &pTz, &pOta};
  for (auto *p : params) wm.addParameter(p);

  wm.setSaveConfigCallback([] { portalSaved = true; });
  wm.setSaveParamsCallback([] { portalSaved = true; });
  wm.setConfigPortalTimeout(600);
  wm.setHostname(HOSTNAME);

  bool connected = forcePortal ? wm.startConfigPortal(SETUP_AP_NAME, SETUP_AP_PASS)
                               : wm.autoConnect(SETUP_AP_NAME, SETUP_AP_PASS);

  if (portalSaved) {
    auto keepIfBlank = [](String &dst, const char *v) {
      if (v && strlen(v)) dst = v;
    };
    cfg.camHost = pCam.getValue();
    cfg.camUser = pCamUser.getValue();
    keepIfBlank(cfg.camPass, pCamPass.getValue());
    cfg.res = pRes.getValue();
    cfg.scriptUrl = pUrl.getValue();
    keepIfBlank(cfg.token, pToken.getValue());
    cfg.mqttUser = pMUser.getValue();
    keepIfBlank(cfg.mqttPass, pMPass.getValue());
    cfg.motionTopic = pTopic.getValue();
    cfg.intervalSec = String(pInt.getValue()).toInt();
    cfg.maxShots = String(pMax.getValue()).toInt();
    cfg.tz = pTz.getValue();
    keepIfBlank(cfg.otaPass, pOta.getValue());
    cfg.camHost.trim();
    cfg.scriptUrl.trim();
    saveConfig();
    loadConfig();  // re-apply validation
    Serial.println("[setup] configuration saved");
  }

  if (!connected) {
    Serial.println("[setup] no WiFi, restarting");
    delay(2000);
    ESP.restart();
  }
}

// ---------------------------------------------------------------------------
// Status web server
// ---------------------------------------------------------------------------
WebServer web(80);

String jsonEscape(const String &s) {
  String o;
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((unsigned char)c < 0x20) o += ' ';
    else o += c;
  }
  return o;
}

void handleStatus() {
  String err;
  portENTER_CRITICAL(&errMux);
  err = lastError;
  portEXIT_CRITICAL(&errMux);
  time_t now = time(nullptr);
  String j = "{";
  j += "\"version\":\"" + String(FW_VERSION) + "\",";
  j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  j += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  j += "\"uptime_s\":" + String(millis() / 1000) + ",";
  j += "\"time_synced\":" + String(now > 1700000000 ? "true" : "false") + ",";
  j += "\"camera\":\"" + jsonEscape(cfg.camHost) + "\",";
  j += "\"script_configured\":" + String(cfg.scriptUrl.length() ? "true" : "false") + ",";
  j += "\"motion_active\":" + String(motionActive ? "true" : "false") + ",";
  j += "\"events\":" + String(statEvents) + ",";
  j += "\"captured\":" + String(statCaptured) + ",";
  j += "\"capture_failed\":" + String(statCaptureFail) + ",";
  j += "\"uploaded\":" + String(statUploaded) + ",";
  j += "\"upload_failed\":" + String(statUploadFail) + ",";
  j += "\"dropped\":" + String(statDropped) + ",";
  j += "\"queued\":" + String(statQueue) + ",";
  j += "\"fs_free\":" + String((uint32_t)(LittleFS.totalBytes() - LittleFS.usedBytes())) + ",";
  j += "\"heap_free\":" + String(ESP.getFreeHeap()) + ",";
  j += "\"heap_max_block\":" + String(ESP.getMaxAllocHeap()) + ",";
  j += "\"last_error\":\"" + jsonEscape(err) + "\"";
  j += "}";
  web.send(200, "application/json", j);
}

void setupWeb() {
  web.on("/", HTTP_GET, [] {
    web.send(200, "text/html",
             "<h3>yicam-bridge</h3><ul>"
             "<li><a href='/status'>/status</a> (JSON)</li>"
             "<li>POST /snap - take a test snapshot now</li>"
             "<li>POST /restart</li></ul>"
             "<p>Hold the BOOT button while resetting to open the setup portal.</p>");
  });
  web.on("/status", HTTP_GET, handleStatus);
  web.on("/snap", HTTP_POST, [] {
    manualShot = true;
    web.send(202, "application/json", "{\"queued\":true}");
  });
  web.on("/restart", HTTP_POST, [] {
    web.send(200, "application/json", "{\"restarting\":true}");
    delay(500);
    ESP.restart();
  });
  web.begin();
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[boot] yicam-bridge %s\n", FW_VERSION);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  if (!LittleFS.begin(true)) {
    Serial.println("[boot] LittleFS mount failed");
  }
  LittleFS.mkdir(QUEUE_DIR);
  LittleFS.remove(String(QUEUE_DIR) + "/partial.tmp");
  loadConfig();

  // Hold BOOT for ~2 s after reset to force the setup portal.
  bool forcePortal = false;
  uint32_t t0 = millis();
  while (millis() - t0 < 2000) {
    digitalWrite(LED_PIN, (millis() / 100) % 2);
    if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
      forcePortal = true;
      break;
    }
    delay(10);
  }
  digitalWrite(LED_PIN, LOW);
  if (forcePortal) Serial.println("[boot] BOOT held: opening setup portal");

  WiFi.setHostname(HOSTNAME);
  runWiFiSetup(forcePortal || cfg.scriptUrl.isEmpty());
  WiFi.setSleep(false);  // lower latency for the broker
  WiFi.setAutoReconnect(true);
  Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());

  configTzTime(cfg.tz.c_str(), "pool.ntp.org", "time.google.com");

  ArduinoOTA.setHostname(HOSTNAME);
  if (cfg.otaPass.length()) ArduinoOTA.setPassword(cfg.otaPass.c_str());
  ArduinoOTA.begin();

  mqtt.subscribe(cfg.motionTopic, [](char *topic, char *payload) {
    onMotionMessage(payload);
  });
  mqtt.begin();
  setupWeb();

  xTaskCreatePinnedToCore(workerTask, "worker", 16384, nullptr, 1, nullptr, 1);
  Serial.println("[boot] ready");
}

void loop() {
  mqtt.loop();
  web.handleClient();
  ArduinoOTA.handle();
  delay(1);
}
