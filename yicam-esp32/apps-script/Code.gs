/**
 * yicam-bridge receiver: saves base64 JPEG snapshots POSTed by the ESP32
 * into Google Drive, one subfolder per day.
 *
 * Script properties (Project Settings -> Script properties):
 *   TOKEN           required. Long random string; must match the ESP32 setting.
 *   FOLDER_ID       optional. Drive folder ID to store images in.
 *                   Default: a folder named "YiCam" in My Drive (created if missing).
 *   RETENTION_DAYS  optional. Used by cleanup(); default 30.
 *
 * Deploy -> New deployment -> Web app
 *   Execute as: Me    Who has access: Anyone
 * Copy the /exec URL into the ESP32 setup portal.
 */

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('TOKEN');
    if (!token || !e || !e.parameter || e.parameter.token !== token) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    if (!e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'empty body' });
    }

    const name = sanitizeName_(e.parameter.name) ||
      'yicam_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.jpg';
    const bytes = Utilities.base64Decode(e.postData.contents.replace(/\s/g, ''));
    if (bytes.length < 2 || (bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8) {
      return json_({ ok: false, error: 'not a JPEG' });
    }

    const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const folder = subfolder_(rootFolder_(), day);
    const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
    return json_({ ok: true, id: file.getId(), name: name, size: bytes.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Simple health check: open the /exec URL in a browser. */
function doGet() {
  return json_({ ok: true, service: 'yicam-bridge receiver' });
}

/** Deletes day folders older than RETENTION_DAYS. Run from a daily time trigger. */
function cleanup() {
  const days = Number(PropertiesService.getScriptProperties().getProperty('RETENTION_DAYS') || 30);
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const folders = rootFolder_().getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.getName()) && new Date(f.getName()) < cutoff) {
      f.setTrashed(true);
    }
  }
}

/** Run once to install the daily cleanup trigger. */
function installCleanupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'cleanup')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(4).create();
}

function rootFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const it = DriveApp.getRootFolder().getFoldersByName('YiCam');
  return it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder('YiCam');
}

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sanitizeName_(s) {
  if (!s) return '';
  const clean = String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return /\.jpe?g$/i.test(clean) ? clean : clean + '.jpg';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
