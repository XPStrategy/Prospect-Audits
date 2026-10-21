/**
 * XP Audit Linker — Google Apps Script (standalone project in the XP Strategy Drive).
 *
 * Drop the files a Claude audit run produces into the Drive folder "XP Audits - Inbox":
 *
 *   [AUDIT]-<Company> - XP Strategy.html                 -> GitHub: accounts/<slug>/audit.html
 *   [AUDIT]-<Company> - XP Strategy - Account Data.xlsx  -> Google Sheet in the account folder
 *   [AUDIT]-<Company> - XP Strategy - PPC Audit.xlsx     -> filed in the account folder
 *   [NOTES]-<Company> - XP Strategy.xlsx                 -> Google Sheet (only if none exists)
 *   <anything>.html named "[AUDIT]-<Company> - XP Strategy - Category.html" / "- SEO.html"
 *                                                        -> GitHub: accounts/<slug>/category.html ...
 *
 * Every 15 minutes (installTrigger) it:
 *   1. finds or creates the account folder  "<Account> - <Prospect> - <Date>"  under Audits
 *   2. converts / refreshes the account sheet — Links, Account Overview and Account Notes
 *      are NEVER overwritten on a refresh, so notes typed in Sheets are safe; data tabs are replaced
 *   3. reads the sheet's tab ids and Links tab, and writes accounts/<slug>/links.json on GitHub
 *      (the hosted pages read this file, so links update without rebuilding the HTML)
 *   4. publishes HTML pages + the account hub (index.html) to GitHub Pages
 *   5. writes the hosted URL back into the sheet and the "XP Audits Library" sheet
 *   6. moves the processed file into <account folder>/_source
 *
 * Script properties (Project Settings > Script properties):
 *   GITHUB_TOKEN      fine-grained token, repo = the audits repo, Contents: Read and write
 *   GITHUB_REPO       e.g. xp-strategy/audits
 *   GITHUB_BRANCH     main
 *   PAGES_BASE        e.g. https://xp-strategy.github.io/audits
 *   INBOX_FOLDER_ID   Drive id of "XP Audits - Inbox"
 *   AUDITS_FOLDER_ID  Drive id of the shared "Audits" folder
 *   LIBRARY_SHEET_ID  (optional — created on first run and saved here)
 *
 * Services: enable the Drive API advanced service (v3) under Services.
 */

var KEEP_TABS = ['Links', 'Account Overview', 'Account Notes'];
var SLUG_SALT = 'xp-audits-v1';   // must match scripts/links.py
var RE_SHEET = /^\[AUDIT\]-(.+) - XP Strategy - Account Data\.xlsx$/;
var RE_PPC = /^\[AUDIT\]-(.+) - XP Strategy - PPC Audit\.xlsx$/;
var RE_NOTES = /^\[NOTES\]-(.+) - XP Strategy\.xlsx$/;
var RE_HTML = /^\[AUDIT\]-(.+?) - XP Strategy(?: - ([A-Za-z ]+))?\.html$/;

function P(k) { return PropertiesService.getScriptProperties().getProperty(k); }

/* ------------------------------------------------------------------ entry points */

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(15).create();
  Logger.log('Trigger installed: processInbox every 15 minutes');
}

function testSetup() {
  ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH', 'PAGES_BASE', 'INBOX_FOLDER_ID', 'AUDITS_FOLDER_ID']
    .forEach(function (k) { if (!P(k)) throw new Error('Missing script property ' + k); });
  DriveApp.getFolderById(P('INBOX_FOLDER_ID'));
  DriveApp.getFolderById(P('AUDITS_FOLDER_ID'));
  var r = gh_('GET', 'templates/hub.html');
  if (!r) throw new Error('templates/hub.html not found in ' + P('GITHUB_REPO'));
  Logger.log('Setup OK: Drive folders reachable, GitHub repo reachable.');
}

function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var inbox = DriveApp.getFolderById(P('INBOX_FOLDER_ID'));
    var files = inbox.getFiles(), queue = [];
    while (files.hasNext()) queue.push(files.next());
    // sheets first (they create the folder + links.json), then html
    queue.sort(function (a, b) { return (/\.html$/.test(a.getName()) ? 1 : 0) - (/\.html$/.test(b.getName()) ? 1 : 0); });
    queue.forEach(function (f) {
      var n = f.getName(), m;
      try {
        if ((m = n.match(RE_SHEET))) handleAccountSheet_(f, m[1]);
        else if ((m = n.match(RE_NOTES))) handleNotes_(f, m[1]);
        else if ((m = n.match(RE_PPC))) fileAway_(f, accountFolder_(m[1], null));
        else if ((m = n.match(RE_HTML))) handleHtml_(f, m[1], m[2]);
      } catch (e) {
        Logger.log('FAILED ' + n + ': ' + e);
        f.setDescription('Linker error ' + new Date().toISOString() + ': ' + e);
      }
    });
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ handlers */

function handleAccountSheet_(file, company) {
  var temp = convert_(file, P('INBOX_FOLDER_ID'));
  var info = readLinksTab_(temp);
  var folder = accountFolder_(company, info.folderName);
  var baseName = '[AUDIT]-' + company + ' - XP Strategy';
  var existing = findSheet_(folder, baseName);
  var target;
  if (existing) {
    target = SpreadsheetApp.openById(existing.getId());
    refreshTabs_(temp, target);
    DriveApp.getFileById(temp.getId()).setTrashed(true);
  } else {
    var tf = DriveApp.getFileById(temp.getId());
    tf.moveTo(folder);
    tf.setName(baseName);
    target = temp;
  }
  var slug = info.slug || slugFor_(company);
  syncLinks_(target, company, slug, folder);
  fileAway_(file, folder);
}

function handleNotes_(file, company) {
  var folder = accountFolder_(company, null);
  var name = '[NOTES]-' + company + ' - XP Strategy';
  if (!findSheet_(folder, name) && !findSheet_(folder, '[AUDIT]-' + company + ' - XP Strategy')) {
    var ss = convert_(file, folder.getId());
    DriveApp.getFileById(ss.getId()).setName(name);
  }
  fileAway_(file, folder);
}

function handleHtml_(file, company, page) {
  var html = file.getBlob().getDataAsString('UTF-8');
  var m = html.match(/<script type="application\/json" id="xp-links">([\s\S]*?)<\/script>/);
  var slug = slugFor_(company);
  if (m) { try { slug = JSON.parse(m[1].replace(/<\\\//g, '</')).slug || slug; } catch (e) {} }
  var key = page ? page.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'audit';
  var dir = 'accounts/' + slug + '/';
  ghPut_(dir + key + '.html', file.getBlob().getBytes(), 'Page: ' + company + ' ' + key);

  // hub page (once) + register the page in links.json
  if (!gh_('GET', dir + 'index.html')) {
    var tpl = gh_('GET', 'templates/hub.html');
    if (tpl) ghPut_(dir + 'index.html', decode_(tpl.content), 'Hub: ' + company);
  }
  var lj = readJson_(dir + 'links.json') || { company: company, slug: slug, items: [], pages: [] };
  if (m && (!lj.items || !lj.items.length)) {          // first publish: seed links from the page
    try { var seed = JSON.parse(m[1].replace(/<\\\//g, '</')); lj.items = seed.items; lj.names = seed.names; } catch (e) {}
  }
  lj.pages = (lj.pages || []).filter(function (p) { return p.file !== key + '.html'; });
  lj.pages.unshift({ key: key, label: pageLabel_(key), file: key + '.html' });
  lj.updated = new Date().toISOString();
  writeJson_(dir + 'links.json', lj, 'Links: ' + company);
  library_(company, null, null, P('PAGES_BASE') + '/' + dir);
  fileAway_(file, accountFolder_(company, lj.folder_name));
}

/* ------------------------------------------------------------------ sheet logic */

function refreshTabs_(src, dst) {
  src.getSheets().forEach(function (sh, idx) {
    var name = sh.getName();
    var old = dst.getSheetByName(name);
    if (old && KEEP_TABS.indexOf(name) >= 0) return;      // never overwrite typed notes
    var copy = sh.copyTo(dst);
    if (old) dst.deleteSheet(old);
    copy.setName(name);
    dst.setActiveSheet(copy);
    dst.moveActiveSheet(Math.min(idx + 1, dst.getNumSheets()));
  });
}

function readLinksTab_(ss) {
  var out = { items: [], files: [], slug: null, folderName: null };
  var sh = ss.getSheetByName('Links');
  if (!sh) return out;
  var v = sh.getDataRange().getValues(), sec = '';
  for (var i = 0; i < v.length; i++) {
    var a = String(v[i][0] || ''), b = String(v[i][1] || ''), c = String(v[i][2] || ''), d = String(v[i][3] || '');
    if (/^Account links/.test(a)) { sec = 'links'; continue; }
    if (/^Client-provided data/.test(a)) { sec = 'files'; continue; }
    if (/^Deliverables/.test(a)) { sec = 'deliv'; continue; }
    if (a === 'Link' || a === 'Label' || a === 'Item') continue;
    var url = /^https?:\/\//.test(b) ? b : null;
    if (sec === 'links' && d) out.items.push({ key: d, label: a, url: url, group: c === 'Client' ? 'client' : 'team' });
    if (sec === 'files' && url) out.files.push({ label: a || 'Client file', url: url, notes: c });
    if (sec === 'deliv' && a === 'Account slug' && b) out.slug = b;
    if (sec === 'deliv' && a === 'Drive folder name' && b) out.folderName = b;
  }
  return out;
}

function writeLinksCell_(ss, label, url) {
  var sh = ss.getSheetByName('Links');
  if (!sh) return;
  var v = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]) === label) {
      sh.getRange(i + 1, 2).setFormula('=HYPERLINK("' + url + '","' + url + '")');
      return;
    }
  }
}

function syncLinks_(ss, company, slug, folder) {
  var info = readLinksTab_(ss);
  var tabs = {};
  ss.getSheets().forEach(function (sh) { tabs[sh.getName()] = sh.getSheetId(); });
  var dir = 'accounts/' + slug + '/';
  var hub = P('PAGES_BASE') + '/' + dir;
  var lj = readJson_(dir + 'links.json') || { company: company, slug: slug, pages: [] };
  var sheetUrl = ss.getUrl();
  lj.company = company; lj.slug = slug;
  lj.folder_name = folder.getName();
  lj.account_sheet = sheetUrl;
  lj.sheet_tabs = tabs;
  lj.client_files = info.files;
  lj.hub_url = hub;
  var prev = {}; (lj.items || []).forEach(function (i) { prev[i.key] = i; });
  lj.items = info.items.map(function (i) {
    if (i.key === 'account_sheet') i.url = sheetUrl;
    if (i.key === 'drive_folder') i.url = folder.getUrl();
    if (!i.url && prev[i.key]) i.url = prev[i.key].url;
    return i;
  });
  lj.updated = new Date().toISOString();
  writeJson_(dir + 'links.json', lj, 'Links: ' + company);
  if (!gh_('GET', dir + 'index.html')) {
    var tpl = gh_('GET', 'templates/hub.html');
    if (tpl) ghPut_(dir + 'index.html', decode_(tpl.content), 'Hub: ' + company);
  }
  writeLinksCell_(ss, 'Hosted account page (GitHub)', hub);
  writeLinksCell_(ss, 'Account data (Google Sheet)', sheetUrl);
  library_(company, folder.getUrl(), sheetUrl, hub);
}

function library_(company, folderUrl, sheetUrl, hubUrl) {
  var id = P('LIBRARY_SHEET_ID'), ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('XP Audits Library');
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(P('AUDITS_FOLDER_ID')));
    ss.getSheets()[0].appendRow(['Company', 'Drive folder', 'Account sheet', 'Hosted page', 'Team view', 'Updated']);
    ss.getSheets()[0].setFrozenRows(1);
    PropertiesService.getScriptProperties().setProperty('LIBRARY_SHEET_ID', ss.getId());
  }
  var sh = ss.getSheets()[0], v = sh.getDataRange().getValues(), row = -1;
  for (var i = 1; i < v.length; i++) if (v[i][0] === company) row = i + 1;
  if (row < 0) { sh.appendRow([company]); row = sh.getLastRow(); }
  if (folderUrl) sh.getRange(row, 2).setValue(folderUrl);
  if (sheetUrl) sh.getRange(row, 3).setValue(sheetUrl);
  if (hubUrl) { sh.getRange(row, 4).setValue(hubUrl); sh.getRange(row, 5).setValue(hubUrl + '?team=1'); }
  sh.getRange(row, 6).setValue(new Date());
}

/* ------------------------------------------------------------------ Drive helpers */

function convert_(file, parentId) {
  var res = Drive.Files.create({ name: file.getName().replace(/\.xlsx$/, ''), mimeType: MimeType.GOOGLE_SHEETS,
                                 parents: [parentId] }, file.getBlob());
  return SpreadsheetApp.openById(res.id);
}

function accountFolder_(company, folderName) {
  var root = DriveApp.getFolderById(P('AUDITS_FOLDER_ID'));
  var it = root.getFolders(), lc = company.toLowerCase();
  while (it.hasNext()) {                          // Maia's "<Account> - <Prospect> - <Date>" folders
    var f = it.next(), n = f.getName().toLowerCase();
    if (n === lc || n.indexOf(lc + ' - ') === 0) return f;
  }
  return root.createFolder(folderName || (company + ' - ' + Utilities.formatDate(new Date(), 'America/New_York', 'MMMM d, yyyy')));
}

function findSheet_(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { var f = it.next(); if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return f; }
  return null;
}

function fileAway_(file, folder) {
  var it = folder.getFoldersByName('_source');
  var src = it.hasNext() ? it.next() : folder.createFolder('_source');
  file.moveTo(src);
}

function pageLabel_(k) {
  return ({ audit: 'PPC Audit', category: 'Category Scorecard', seo: 'SEO / Listing Review',
            asin: 'ASIN Scorecard', global: 'Global Scorecard' })[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}

function slugFor_(company) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SLUG_SALT + ':' + company.toLowerCase(),
                                  Utilities.Charset.UTF_8);
  var hex = d.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 8);
  var s = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
  return s + '-' + hex;
}

/* ------------------------------------------------------------------ GitHub helpers */

function gh_(method, path, body) {
  var url = 'https://api.github.com/repos/' + P('GITHUB_REPO') + '/contents/' +
            path.split('/').map(encodeURIComponent).join('/') +
            (method === 'GET' ? '?ref=' + encodeURIComponent(P('GITHUB_BRANCH') || 'main') : '');
  var opt = { method: method, muteHttpExceptions: true,
              headers: { Authorization: 'Bearer ' + P('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var r = UrlFetchApp.fetch(url, opt), code = r.getResponseCode();
  if (method === 'GET' && code === 404) return null;
  if (code >= 300) throw new Error('GitHub ' + method + ' ' + path + ' -> ' + code + ' ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

function ghPut_(path, content, message) {
  var cur = gh_('GET', path);
  var b64 = typeof content === 'string' ? Utilities.base64Encode(content, Utilities.Charset.UTF_8)
                                        : Utilities.base64Encode(content);
  var body = { message: message, content: b64, branch: P('GITHUB_BRANCH') || 'main' };
  if (cur && cur.sha) body.sha = cur.sha;
  return gh_('PUT', path, body);
}

function decode_(b64) {
  return Utilities.newBlob(Utilities.base64Decode(String(b64 || '').replace(/\n/g, ''))).getDataAsString('UTF-8');
}

function readJson_(path) {
  var r = gh_('GET', path);
  if (!r) return null;
  try { return JSON.parse(decode_(r.content)); } catch (e) { return null; }
}

function writeJson_(path, obj, message) {
  return ghPut_(path, JSON.stringify(obj, null, 2), message);
}
