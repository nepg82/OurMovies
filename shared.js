// Helpers shared by the shelf (index.html) and the admin page (admin.html).
// Load this BEFORE app.js / import.js / migrate.js.

const MAX_RETRIES = 3;

// --- Writing credits ------------------------------------------------------
// Ranked so the "main" writer(s) surface first. Anything not in this list
// (Consultant, Dialogue, etc.) sorts after all of these.
const WRITER_JOB_PRIORITY = ['Screenplay', 'Writer', 'Story', 'Teleplay', 'Novel'];
const WRITER_LIMIT = 4;

function writerJobRank(job) {
  const idx = WRITER_JOB_PRIORITY.indexOf(job);
  return idx === -1 ? WRITER_JOB_PRIORITY.length : idx;
}

// Takes a TMDB credits.crew array, returns up to WRITER_LIMIT { job, name }
// entries from the Writing department, ordered by job priority, then by
// TMDB's own crew order within a tied job.
function extractWriters(crew) {
  const writingCrew = (crew || []).filter(c => c.department === 'Writing');
  const indexed = writingCrew.map((c, i) => ({ job: c.job, name: c.name, _i: i }));
  indexed.sort((a, b) => writerJobRank(a.job) - writerJobRank(b.job) || a._i - b._i);
  return indexed.slice(0, WRITER_LIMIT).map(c => ({ job: c.job, name: c.name }));
}

// --- Titles ---------------------------------------------------------------
const ARTICLES = ['the ', 'a ', 'an '];
function sortTitleOf(t) {
  const low = t.toLowerCase();
  for (const a of ARTICLES) {
    if (low.startsWith(a)) return t.slice(a.length);
  }
  return t;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// --- Sorting --------------------------------------------------------------
// Effective sort key: hand-typed customSort wins, then the auto-generated
// sortTitle, then the real title. customSort is used verbatim (no article
// stripping) because it was typed on purpose.
function effectiveSort(m) {
  return (m.customSort || '').trim() || m.sortTitle || m.title || '';
}

// Numeric-aware, case-insensitive: "Fast 2" sorts before "Fast 10".
const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareMovies(a, b) {
  return sortCollator.compare(effectiveSort(a), effectiveSort(b))
    || sortCollator.compare(a.title || '', b.title || '')
    || sortCollator.compare(a.year || '', b.year || '')
    || sortCollator.compare(a.medium || '', b.medium || '');
}

function letterOf(key) {
  const c = (key || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

// --- Record identity ------------------------------------------------------
// `id` is the film's identity (IMDb/TMDB id) and is shared by duplicates.
// `uid` identifies one specific record, for edit/delete. Until the first push
// persists real uids, assign stable interim ones from id + occurrence order.
function assignUids(movies) {
  const seen = new Map();
  for (const m of movies) {
    const n = seen.get(m.id) || 0;
    seen.set(m.id, n + 1);
    if (!m.uid) m.uid = `${m.id}~${n}`;
  }
}

// --- Network --------------------------------------------------------------
async function fetchJsonWithRetry(url) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url);
    if (res.status === 401) {
      const err = new Error('TMDB rejected the API key (401 Unauthorized).');
      err.isAuthError = true;
      throw err;
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      attempt++;
      await new Promise(r => setTimeout(r, 800 * attempt));
      continue;
    }
    if (!res.ok) {
      return null;
    }
    return res.json();
  }
}

// --- Misc -----------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
