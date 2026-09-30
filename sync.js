// Sync engine: pending-change queue (IndexedDB), date-stamp tracking, and
// atomic pushes to GitHub via the Git Data API. Depends on shared.js.
// Load on both index.html and admin.html, after shared.js.

const SYNC_KEYS = {
  token: 'movieShelf_ghToken',
  owner: 'movieShelf_ghOwner',
  repo: 'movieShelf_ghRepo',
  branch: 'movieShelf_ghBranch',
};
const NO_POSTER_PATH = 'thumbs/_no-poster.svg';

// baseStamp = stamp of the Git data this device's pending changes sit on top of.
const SYNC = { baseStamp: null };
let PENDING_COVER_URLS = {}; // cover path -> object URL, for covers not pushed yet
let syncPushing = false;

/* ---------- Stamps: YYMMDD-HHMM, local time ---------- */

function makeStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Used if two pushes land in the same minute, so stamps always increase.
function bumpStamp(stamp) {
  const m = /^(\d\d)(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(stamp || '');
  if (!m) return makeStamp();
  return makeStamp(new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5] + 1));
}

/* ---------- IndexedDB ---------- */
// stores: ops (queue), covers ({path, blob} awaiting push), meta (key/value)

let _dbPromise = null;
function openDb() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('movieShelf', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
        db.createObjectStore('covers', { keyPath: 'path' });
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _dbPromise;
}

function dbRun(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let out;
    r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const dbGet = (s, k) => dbRun(s, 'readonly', o => o.get(k));
const dbAll = (s) => dbRun(s, 'readonly', o => o.getAll());
const dbPut = (s, v, k) => dbRun(s, 'readwrite', o => (k === undefined ? o.put(v) : o.put(v, k)));
const dbDelete = (s, k) => dbRun(s, 'readwrite', o => o.delete(k));
const dbClear = (s) => dbRun(s, 'readwrite', o => o.clear());

/* ---------- Operations ---------- */
// { type:'add', movie }                  (+ cover blob stored separately)
// { type:'edit', uid, changes:{...} }    (blank customSort removes it)
// { type:'delete', uid }

function applyChanges(m, changes) {
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'customSort' && !String(v == null ? '' : v).trim()) delete m.customSort;
    else m[k] = v;
  }
  // Renaming regenerates the auto sort title; customSort is never touched.
  if ('title' in changes && !('sortTitle' in changes)) m.sortTitle = sortTitleOf(m.title || '');
}

// Pure: returns a new list, never mutates `base`.
function applyOps(base, ops) {
  let list = base.map(m => ({ ...m }));
  for (const op of ops) {
    if (op.type === 'add') {
      if (!list.some(m => m.uid === op.movie.uid)) list.push({ ...op.movie });
    } else if (op.type === 'delete') {
      list = list.filter(m => m.uid !== op.uid);
    } else if (op.type === 'edit') {
      const m = list.find(x => x.uid === op.uid);
      if (m) applyChanges(m, op.changes || {});
    }
  }
  return list;
}

function genUid() {
  return 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
}

function syncChanged(reload) {
  document.dispatchEvent(new CustomEvent('syncchange', { detail: { reload: !!reload } }));
}

async function queueOp(op, cover) {
  if (cover) {
    op.coverPath = cover.path;
    await dbPut('covers', { path: cover.path, blob: cover.blob });
  }
  await dbPut('ops', op);
  await loadPendingCovers();
  syncChanged(false);
}

async function getPendingCount() {
  return (await dbAll('ops')).length;
}

async function discardChanges() {
  await dbClear('ops');
  await dbClear('covers');
  await loadPendingCovers();
  syncChanged(false);
}

async function loadPendingCovers() {
  for (const url of Object.values(PENDING_COVER_URLS)) URL.revokeObjectURL(url);
  PENDING_COVER_URLS = {};
  for (const row of await dbAll('covers')) PENDING_COVER_URLS[row.path] = URL.createObjectURL(row.blob);
}

function coverSrc(m) {
  return PENDING_COVER_URLS[m.cover] || m.cover;
}

/* ---------- Loading the base data ---------- */

// Loads the site's data.json + version.json. If the person previously accepted
// newer data from Git (stored in IndexedDB) and Pages hasn't caught up yet,
// that copy wins. Returns { movies, stamp }; pending ops are applied by the caller.
async function syncInit() {
  const res = await fetch('data.json', { cache: 'no-store' });
  let movies = await res.json();
  let stamp = null;
  try {
    const v = await fetch('version.json', { cache: 'no-store' });
    if (v.ok) stamp = (await v.json()).stamp || null;
  } catch (e) { /* no version.json yet */ }

  const copy = await dbGet('meta', 'gitCopy');
  if (copy) {
    if (!stamp || copy.stamp > stamp) { movies = copy.movies; stamp = copy.stamp; }
    else await dbDelete('meta', 'gitCopy'); // Pages caught up
  }
  assignUids(movies);
  SYNC.baseStamp = stamp;
  await loadPendingCovers();
  return { movies, stamp };
}

async function renderSyncIndicator() {
  const el = document.getElementById('syncStamp');
  if (!el) return;
  const n = await getPendingCount();
  el.textContent = (SYNC.baseStamp || 'no stamp') + (n ? ` \u00b7 ${n} unpushed` : '');
  el.classList.toggle('dirty', n > 0);
  el.title = n ? 'Unpushed changes \u2014 open Admin to push' : 'Data is in sync with the last push';
}

/* ---------- GitHub ---------- */

function ghConfig() {
  return {
    token: localStorage.getItem(SYNC_KEYS.token) || '',
    owner: localStorage.getItem(SYNC_KEYS.owner) || '',
    repo: localStorage.getItem(SYNC_KEYS.repo) || '',
    branch: localStorage.getItem(SYNC_KEYS.branch) || 'main',
  };
}
function ghReady() {
  const c = ghConfig();
  return !!(c.token && c.owner && c.repo);
}

function ghHeaders(accept, hasBody) {
  const c = ghConfig();
  return {
    Authorization: `Bearer ${c.token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function ghFail(res) {
  let msg = '';
  try { msg = (await res.json()).message; } catch (e) { /* ignore */ }
  const err = new Error(`GitHub ${res.status}${msg ? ': ' + msg : ''}`);
  err.status = res.status;
  return err;
}

async function gh(path, { method = 'GET', body } = {}) {
  const c = ghConfig();
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}${path}`, {
    method,
    cache: 'no-store',
    headers: ghHeaders('application/vnd.github+json', !!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await ghFail(res);
  return res.json();
}

// Raw file text from the repo (works past the 1 MB JSON limit). null if missing.
async function ghRaw(file) {
  const c = ghConfig();
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${file}?ref=${encodeURIComponent(c.branch)}`, {
    cache: 'no-store',
    headers: ghHeaders('application/vnd.github.raw+json', false),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await ghFail(res);
  return res.text();
}

async function ghGetStamp() {
  const txt = await ghRaw('version.json');
  if (!txt) return null;
  try { return JSON.parse(txt).stamp || null; } catch (e) { return null; }
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------- Startup check: is Git ahead of what I loaded? ---------- */

async function checkGitOnStartup() {
  if (!ghReady()) return;
  try {
    const gitStamp = await ghGetStamp();
    if (!gitStamp) return;
    if (SYNC.baseStamp && gitStamp <= SYNC.baseStamp) return;
    if (sessionStorage.getItem('movieShelf_dismissedStamp') === gitStamp) return;
    await showNewerDialog(gitStamp);
  } catch (e) {
    console.warn('Git check skipped:', e.message); // offline, bad token, etc.
  }
}

async function loadNewerFromGit(gitStamp) {
  const raw = await ghRaw('data.json');
  if (!raw) throw new Error('data.json not found in the repo.');
  await dbPut('meta', { stamp: gitStamp, movies: JSON.parse(raw) }, 'gitCopy');
  syncChanged(true);
}

async function showNewerDialog(gitStamp) {
  const n = await getPendingCount();
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `
    <div class="sheet" role="alertdialog" aria-modal="true" aria-label="Newer data on Git">
      <h2 class="sheet-title">Newer data on Git</h2>
      <p class="sheet-text">The repo has a push stamped <strong>${escapeHtml(gitStamp)}</strong>; this device loaded
        <strong>${escapeHtml(SYNC.baseStamp || 'an unstamped copy')}</strong>.
        ${n ? `Your ${n} unpushed change${n === 1 ? '' : 's'} will be re-applied on top.` : ''}</p>
      <p class="sheet-error" id="newerErr"></p>
      <div class="sheet-actions">
        <button class="btn" id="newerLoad">Load newer data</button>
        <button class="btn secondary" id="newerLater">Not now</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#newerLater').onclick = () => {
    sessionStorage.setItem('movieShelf_dismissedStamp', gitStamp);
    el.remove();
  };
  el.querySelector('#newerLoad').onclick = async () => {
    const btn = el.querySelector('#newerLoad');
    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
      await loadNewerFromGit(gitStamp);
      el.remove();
    } catch (e) {
      el.querySelector('#newerErr').textContent = 'Could not load: ' + e.message;
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  };
}

/* ---------- Push: one atomic commit ---------- */

async function evictCachedCovers(paths) {
  if (typeof caches === 'undefined') return;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const p of paths) await cache.delete(new URL(p, location.href).href);
  }
}

async function pushChanges(log = () => {}) {
  if (syncPushing) throw new Error('A push is already running.');
  if (!ghReady()) throw new Error('Save your GitHub settings in Admin first.');
  const ops = await dbAll('ops');
  if (!ops.length) { log('Nothing to push.'); return null; }

  syncPushing = true;
  try {
    const { branch } = ghConfig();

    log('Reading the branch...');
    const ref = await gh(`/git/ref/heads/${branch}`);
    const headSha = ref.object.sha;
    const head = await gh(`/git/commits/${headSha}`);
    const baseTree = head.tree.sha;

    const gitStamp = await ghGetStamp();
    if (gitStamp && (!SYNC.baseStamp || gitStamp > SYNC.baseStamp)) {
      throw new Error(`Git has newer data (${gitStamp}) than this device loaded (${SYNC.baseStamp || 'unstamped'}). Load the newer data first, then push.`);
    }

    log('Applying changes to the latest data.json...');
    const raw = await ghRaw('data.json');
    const gitMovies = raw ? JSON.parse(raw) : [];
    assignUids(gitMovies);
    const newMovies = applyOps(gitMovies, ops); // uids (interim ones included) get written out here

    const entries = [];

    // New cover images
    const covers = await dbAll('covers');
    const addedPaths = new Set(ops.filter(o => o.type === 'add' && o.coverPath).map(o => o.coverPath));
    for (const c of covers) {
      if (!addedPaths.has(c.path)) continue;
      log(`Uploading ${c.path}...`);
      const b = await gh('/git/blobs', { method: 'POST', body: { content: await blobToBase64(c.blob), encoding: 'base64' } });
      entries.push({ path: c.path, mode: '100644', type: 'blob', sha: b.sha });
    }

    // Covers no remaining record points at (never the placeholder)
    const stillUsed = new Set(newMovies.map(m => m.cover));
    const orphanCandidates = [...new Set(gitMovies.map(m => m.cover))]
      .filter(p => p && p.startsWith('thumbs/') && p !== NO_POSTER_PATH && !stillUsed.has(p));
    const removedCovers = [];
    if (orphanCandidates.length) {
      const tree = await gh(`/git/trees/${baseTree}?recursive=1`);
      const existing = new Set(tree.tree.map(t => t.path));
      for (const p of orphanCandidates) {
        if (existing.has(p)) {
          entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
          removedCovers.push(p);
        }
      }
    }

    let stamp = makeStamp();
    if (gitStamp && stamp <= gitStamp) stamp = bumpStamp(gitStamp);

    log('Writing data.json and version.json...');
    const dataBlob = await gh('/git/blobs', { method: 'POST', body: { content: JSON.stringify(newMovies, null, 2), encoding: 'utf-8' } });
    const verBlob = await gh('/git/blobs', { method: 'POST', body: { content: JSON.stringify({ stamp }, null, 2) + '\n', encoding: 'utf-8' } });
    entries.push({ path: 'data.json', mode: '100644', type: 'blob', sha: dataBlob.sha });
    entries.push({ path: 'version.json', mode: '100644', type: 'blob', sha: verBlob.sha });

    log('Committing...');
    const tree = await gh('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: entries } });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: { message: `Update collection: ${ops.length} change${ops.length === 1 ? '' : 's'} [${stamp}]`, tree: tree.sha, parents: [headSha] },
    });
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha } });

    // Success: drop only the ops we pushed, remember the pushed copy until Pages catches up.
    for (const op of ops) await dbDelete('ops', op.seq);
    for (const p of addedPaths) await dbDelete('covers', p);
    await dbPut('meta', { stamp, movies: newMovies }, 'gitCopy');
    await evictCachedCovers(removedCovers);
    syncChanged(true);

    log(`Pushed ${ops.length} change${ops.length === 1 ? '' : 's'} as ${stamp}` +
        (removedCovers.length ? `, removed ${removedCovers.length} cover file${removedCovers.length === 1 ? '' : 's'}` : '') +
        '. The live site updates in about a minute.');
    return { stamp, commit: commit.sha };
  } finally {
    syncPushing = false;
  }
}
