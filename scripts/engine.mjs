// VHF update engine: tracks every Code-block file's versions over time, what's on the live copy page,
// and what still needs pasting. Serves engine.html (and the whole hub) on http://localhost:8091.
// Usage:
//   node scripts/engine.mjs                  serve + watch files (default)
//   node scripts/engine.mjs status           print what needs pushing (no server needed)
//   node scripts/engine.mjs check [file|all] compare local files with the live copy pages
//   node scripts/engine.mjs note <file> "why" attach a note to the file's latest version
// History lives in updates/ (history.json + content-addressed snapshots). The calendar key is
// filled in from the live site at copy time and never written to disk.
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import vm from 'vm';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'updates');
const snapDir = path.join(dataDir, 'snapshots');
const histFile = path.join(dataDir, 'history.json');
const PORT = Number(process.env.ENGINE_PORT) || 8091;
const SITE = 'https://www.veteranshealingfarm.org';
const ADMIN = 'https://lychee-porcupine-awgb.squarespace.com';
const KEY_HOLDER = '__VHF_CAL_KEY__';

// Targets: the hub's PAGES array is the source of truth for pages; the two site-wide pastes are added here.
function targets() {
  const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = src.match(/var PAGES=(\[[\s\S]*?\n\]);/);
  const pages = vm.runInNewContext(m[1]);
  const list = pages.filter(p => !/-hero\.html$/.test(p.f)).map(p => ({
    t: p.t, f: p.f, copy: p.copy, orig: p.orig, tag: p.tag, note: p.note || '',
    where: 'the Code block on the copy page', check: p.copy
  }));
  // Programs has two Code blocks on one page.
  for (const p of list) if (/programs-[ab]\.html$/.test(p.f)) p.where = 'Code block ' + (p.f.includes('-a') ? '1 (top)' : '2 (bottom)') + ' on the copy page';
  list.push({ t: 'Custom CSS', f: 'site/custom.less', where: 'Design → Custom CSS (site-wide)', note: 'Squarespace compiles the LESS, so the live text can\'t be compared: mark it pushed after pasting.', check: null });
  list.push({ t: 'Preview mode (Code Injection)', f: 'site/preview-mode.html', where: 'Settings → Advanced → Code Injection → Header (below anything already there)', note: 'Staff-only preview switch. Remove from Code Injection after the last swap.', check: '/' });
  return list;
}

const hash = s => crypto.createHash('sha1').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
const norm = s => s.replace(/\s+/g, '');
const snapPath = (f, h) => path.join(snapDir, f.replace(/[\\/]/g, '__'), h + '.txt');

function load() {
  try { return JSON.parse(fs.readFileSync(histFile, 'utf8')) } catch { return { files: {} } }
}
// Read-modify-write with a fresh read each time, so the server and the CLI can both write.
function mutate(fn) {
  const h = load(); const r = fn(h);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(histFile + '.tmp', JSON.stringify(h, null, 1)); fs.renameSync(histFile + '.tmp', histFile);
  return r;
}
const rec = (h, f) => h.files[f] || (h.files[f] = { versions: [], pushes: [], lastCheck: null });

// Snapshot a file if its content differs from its latest version. Returns the new version or null.
function snap(f, source = 'edit') {
  const full = path.join(root, f);
  if (!fs.existsSync(full)) return null;
  const text = fs.readFileSync(full, 'utf8'), hsh = hash(text);
  return mutate(h => {
    const r = rec(h, f), last = r.versions[r.versions.length - 1];
    if (last && last.hash === hsh) return null;
    const sp = snapPath(f, hsh);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    if (!fs.existsSync(sp)) fs.writeFileSync(sp, text);
    const v = { hash: hsh, at: new Date().toISOString(), lines: text.split('\n').length, bytes: Buffer.byteLength(text), source, note: '' };
    r.versions.push(v); return v;
  });
}
const scanAll = source => targets().map(t => snap(t.f, source)).filter(Boolean);

function state() {
  const h = load();
  return {
    site: SITE, admin: ADMIN,
    targets: targets().map(t => {
      const r = h.files[t.f] || { versions: [], pushes: [], lastCheck: null };
      const cur = r.versions[r.versions.length - 1] || null, push = r.pushes[r.pushes.length - 1] || null;
      // A live check newer than the last recorded push that found no match also means "needs push".
      let status = 'unknown';
      if (cur && push) status = push.hash === cur.hash ? 'synced' : 'changed';
      if (r.lastCheck && r.lastCheck.result === 'differs' && (!push || r.lastCheck.at > push.at)) status = 'changed';
      const pending = push ? r.versions.filter(v => v.at > push.at && v.hash !== push.hash) : [];
      let hasKey = false; try { hasKey = fs.readFileSync(path.join(root, t.f), 'utf8').includes(KEY_HOLDER) } catch {}
      return { ...t, status, current: cur, lastPush: push, lastCheck: r.lastCheck, versions: r.versions, pushes: r.pushes, pendingEdits: pending.length, hasKey };
    })
  };
}

// ---- Live comparison ----------------------------------------------------------------------
async function fetchPage(p) {
  const res = await fetch(SITE + p + (p.includes('?') ? '&' : '?') + 'nocache=' + Date.now(), { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + p);
  return res.text();
}
// The key placeholder matches whatever the live page has in its place.
const containsText = (pageNorm, text) => norm(text).split(KEY_HOLDER).every(part => pageNorm.includes(part));

async function check(f) {
  const t = targets().find(x => x.f === f);
  if (!t) throw new Error('Unknown file ' + f);
  if (!t.check) return { f, result: 'manual', message: 'No live comparison for this file; mark it pushed after pasting.' };
  snap(f, 'edit');
  let page;
  try { page = await fetchPage(t.check) } catch (e) {
    const lc = { at: new Date().toISOString(), result: 'error', message: e.message };
    mutate(h => { rec(h, f).lastCheck = lc }); return { f, ...lc };
  }
  const pn = norm(page), h0 = load(), r = h0.files[f];
  // Which recorded version is live? Newest first.
  let liveV = null;
  for (const v of [...r.versions].reverse()) {
    const sp = snapPath(f, v.hash);
    if (fs.existsSync(sp) && containsText(pn, fs.readFileSync(sp, 'utf8'))) { liveV = v; break; }
  }
  const cur = r.versions[r.versions.length - 1];
  const lc = { at: new Date().toISOString(), result: liveV ? (liveV.hash === cur.hash ? 'match' : 'older') : 'differs', liveHash: liveV && liveV.hash };
  if (!liveV) {
    // Lines of the local file that don't appear on the live page, as a hint of what's out of date.
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const missing = text.split('\n').map(l => l.trim()).filter(l => l.length > 15 && !l.includes(KEY_HOLDER) && !pn.includes(norm(l)));
    lc.missingCount = missing.length; lc.missing = missing.slice(0, 12);
  }
  mutate(h => {
    const rr = rec(h, f); rr.lastCheck = lc;
    const lp = rr.pushes[rr.pushes.length - 1];
    if (liveV && (!lp || lp.hash !== liveV.hash)) rr.pushes.push({ hash: liveV.hash, at: lc.at, via: 'live check' });
  });
  return { f, ...lc };
}
async function checkAll() {
  const out = [];
  for (const t of targets()) if (t.check) out.push(await check(t.f).catch(e => ({ f: t.f, result: 'error', message: e.message })));
  return out;
}

function markPushed(f, hsh) {
  return mutate(h => {
    const r = rec(h, f), v = hsh ? r.versions.find(x => x.hash === hsh) : r.versions[r.versions.length - 1];
    if (!v) throw new Error('No version to mark');
    const p = { hash: v.hash, at: new Date().toISOString(), via: 'marked by hand' }; r.pushes.push(p); return p;
  });
}
function addNote(f, note, hsh) {
  snap(f, 'edit');
  return mutate(h => {
    const r = rec(h, f), v = hsh ? r.versions.find(x => x.hash === hsh) : r.versions[r.versions.length - 1];
    if (!v) throw new Error('No version of ' + f);
    v.note = v.note ? v.note + ' · ' + note : note; return v;
  });
}

let calKey = null;
async function key() {
  if (calKey) return calKey;
  for (const p of ['/beekeeping-1', '/garden-1', '/herb-1', '/events-1']) {
    try { const m = (await fetchPage(p)).match(/KEY=['"](AIza[\w-]{20,})['"]/); if (m) return (calKey = m[1]); } catch {}
  }
  throw new Error('Calendar key not found on the live copy pages');
}

// ---- CLI -----------------------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
const label = { synced: 'in sync', changed: 'NEEDS PUSH', unknown: 'not checked' };
if (cmd === 'status') {
  scanAll('edit');
  for (const t of state().targets) {
    const extra = t.status === 'changed' && t.lastPush ? ` (${t.pendingEdits} edit${t.pendingEdits === 1 ? '' : 's'} since ${t.lastPush.at.slice(0, 16).replace('T', ' ')})` : '';
    console.log(label[t.status].padEnd(12), t.f.padEnd(32), (t.copy || '').padEnd(16), extra);
  }
  process.exit(0);
} else if (cmd === 'check') {
  const res = !args[0] || args[0] === 'all' ? await checkAll() : [await check(args[0])];
  for (const r of res) console.log(r.result.padEnd(8), r.f, r.missingCount ? `(${r.missingCount} lines not on live, e.g. ${JSON.stringify(r.missing[0])})` : r.message || '');
  process.exit(0);
} else if (cmd === 'note') {
  if (!targets().some(t => t.f === args[0])) { console.log('Not a tracked file: ' + args[0] + '. Use a path like content/faq-full.html'); process.exit(1); }
  const v = addNote(args[0], args.slice(1).join(' '));
  console.log('noted on', args[0], v.hash); process.exit(0);
} else if (cmd && cmd !== 'serve') {
  console.log('Unknown command. Use: serve | status | check [file|all] | note <file> "text"'); process.exit(1);
}

// ---- Server --------------------------------------------------------------------------------
const clients = new Set();
const broadcast = () => { for (const c of clients) c.write('data: changed\n\n') };

// Only the instance that owns the port scans and watches, so two engines never both write history.
const timers = {};
const tracked = () => new Set(targets().map(t => t.f));
function startWatching() {
  scanAll('found at startup');
  for (const dir of ['content', 'site']) {
    fs.watch(path.join(root, dir), (ev, name) => {
      if (!name) return;
      const f = dir + '/' + name.replace(/\\/g, '/');
      if (!tracked().has(f)) return;
      clearTimeout(timers[f]);
      timers[f] = setTimeout(() => { if (snap(f, 'edit')) { console.log('new version', f); broadcast(); } }, 800);
    });
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.less': 'text/plain', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')) } catch { r({}) } }) });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  // Local pages only: another site's page can't drive the API.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'origin' });
  if (origin) res.setHeader('access-control-allow-origin', origin);
  try {
    if (u.pathname === '/api/state') return send(res, 200, state());
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('data: hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (u.pathname === '/api/version') {
      const f = u.searchParams.get('f'), h = u.searchParams.get('h');
      if (!tracked().has(f) || !/^[0-9a-f]{12}$/.test(h)) return send(res, 400, { error: 'bad file or hash' });
      return send(res, 200, fs.readFileSync(snapPath(f, h), 'utf8'), 'text/plain');
    }
    if (u.pathname === '/api/copy') {
      const f = u.searchParams.get('f');
      if (!tracked().has(f)) return send(res, 400, { error: 'bad file' });
      let text = fs.readFileSync(path.join(root, f), 'utf8');
      if (text.includes(KEY_HOLDER)) text = text.split(KEY_HOLDER).join(await key());
      return send(res, 200, text, 'text/plain');
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      const b = await body(req);
      if (b.f && !tracked().has(b.f)) return send(res, 400, { error: 'bad file' });
      let out;
      if (u.pathname === '/api/check') out = b.f ? await check(b.f) : await checkAll();
      else if (u.pathname === '/api/push') out = markPushed(b.f, b.hash);
      else if (u.pathname === '/api/note') out = addNote(b.f, String(b.note || '').slice(0, 500), b.hash);
      else if (u.pathname === '/api/scan') out = scanAll('edit');
      else return send(res, 404, { error: 'unknown' });
      broadcast(); return send(res, 200, out);
    }
    // Static files for the hub, never the credentials.
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/engine.html';
    const full = path.join(root, p);
    if (!full.startsWith(root) || /(^|[\\/])\.|squarespace-tokens|[\\/]updates[\\/]/i.test(path.relative(root, full))) return send(res, 403, 'Forbidden', 'text/plain');
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    if (!fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(full), TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream');
  } catch (e) { return send(res, 500, { error: e.message }); }
});
// If another engine already serves the port (e.g. one started by another session), stand by
// instead of crashing: it keeps recording versions, and this one takes over if it stops.
let standing = false;
server.on('listening', () => {
  console.log((standing ? 'Took over: ' : '') + 'VHF update engine on http://localhost:' + PORT + '  (hub: /index.html)');
  startWatching();
});
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') throw e;
  let engine = false;
  try { engine = /VHF Update Engine/.test(await (await fetch('http://localhost:' + PORT + '/')).text()); } catch {}
  if (!engine) { console.error('Port ' + PORT + ' is in use by something other than the engine. Free it or set ENGINE_PORT.'); process.exit(1); }
  if (!standing) {
    console.log('VHF update engine already running on http://localhost:' + PORT + '  (hub: /index.html); standing by.');
    // A preview launcher may hand us its own PORT: forward it to the running engine so the tab works.
    const alt = Number(process.env.PORT);
    if (alt && alt !== PORT) http.createServer((req, res) => {
      const up = http.request({ host: 'localhost', port: PORT, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end('Engine not reachable'); });
      req.pipe(up);
    }).listen(alt, () => console.log('Forwarding http://localhost:' + alt + ' to the running engine'));
  }
  standing = true;
  setTimeout(() => server.listen(PORT), 5000);
});
server.listen(PORT);
