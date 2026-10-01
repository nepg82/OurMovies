// "Add a movie": TMDB title search + manual entry. Queues an 'add' op (and a
// cover blob when one needs uploading); nothing touches Git until Push.
// Depends on shared.js and sync.js. Load after admin.js.

const TMDB_IMG = 'https://image.tmdb.org/t/p/';
let addResultsList = [];
let addPicked = null;     // { movie, posterPath }
let addCurrent = [];      // current collection incl. pending changes (for dupes / datalists)
let addLastMedium = '';   // remembered so batch entry doesn't retype it

const $a = (id) => document.getElementById(id);
const tmdbKey = () => localStorage.getItem('movieShelf_tmdbKey') || '';

async function refreshAddContext() {
  if (!SYNC.movies) await syncInit();
  addCurrent = applyOps(SYNC.movies, await dbAll('ops'));
  const distinct = (k) => [...new Set(addCurrent.map(m => m[k]).filter(Boolean))].sort();
  const opts = (arr) => arr.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
  $a('dlAddMedium').innerHTML = opts(distinct('medium'));
  $a('dlAddGenre').innerHTML = opts(distinct('genre'));
}

function addSay(msg) { $a('addMsg').textContent = msg || ''; }

function dupWarning(id, medium) {
  const med = (medium || '').trim().toLowerCase();
  if (!id || !med) return '';
  const hit = addCurrent.find(m => m.id === id && (m.medium || '').toLowerCase() === med);
  return hit ? `You already have "${hit.title}" on ${hit.medium}. You can still add it (e.g. a true duplicate you'll sort out later).` : '';
}

function finalizeMovie(f, cover) {
  const movie = {
    id: f.id,
    uid: genUid(),
    title: f.title,
    sortTitle: sortTitleOf(f.title),
    director: f.director || '',
    year: f.year || '',
    actors: f.actors || [],
    writers: f.writers || [],
    genre: f.genre || '',
    medium: f.medium,
    cover,
    needsReview: '',
  };
  if (f.customSort) movie.customSort = f.customSort;
  return movie;
}

/* ---------- TMDB search ---------- */

async function addSearch() {
  const q = $a('addQuery').value.trim();
  const y = $a('addYear').value.trim();
  if (!q) return;
  if (!tmdbKey()) { addSay('Save your TMDB API key above first.'); return; }
  addSay('');
  $a('addPickBox').innerHTML = '';
  $a('addResults').innerHTML = '<div class="field-hint">Searching...</div>';
  try {
    const data = await fetchJsonWithRetry(
      `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey()}&query=${encodeURIComponent(q)}${y ? '&year=' + encodeURIComponent(y) : ''}`);
    addResultsList = ((data && data.results) || []).slice(0, 8);
    renderAddResults();
  } catch (err) {
    $a('addResults').innerHTML = '';
    addSay('Search failed: ' + err.message);
  }
}

function renderAddResults() {
  if (!addResultsList.length) {
    $a('addResults').innerHTML = '<div class="field-hint">No matches. Try fewer words, or enter it manually.</div>';
    return;
  }
  $a('addResults').innerHTML = '<div class="add-results">' + addResultsList.map((r, i) => {
    const yr = (r.release_date || '').slice(0, 4);
    const img = r.poster_path ? `<img src="${TMDB_IMG}w92${escapeHtml(r.poster_path)}" alt="">` : '<div class="add-noimg"></div>';
    const over = (r.overview || '').slice(0, 110);
    return `<div class="add-result" data-i="${i}">${img}<div><div class="r-title">${escapeHtml(r.title)} <span>${yr ? '(' + escapeHtml(yr) + ')' : ''}</span></div>
      <div class="r-over">${escapeHtml(over)}${(r.overview || '').length > 110 ? '\u2026' : ''}</div></div></div>`;
  }).join('') + '</div>';
}

async function addPickResult(i) {
  const r = addResultsList[i];
  if (!r) return;
  $a('addPickBox').innerHTML = '<div class="field-hint">Loading details...</div>';
  try {
    const det = await fetchJsonWithRetry(`https://api.themoviedb.org/3/movie/${r.id}?api_key=${tmdbKey()}&append_to_response=credits`);
    if (!det) throw new Error('TMDB returned no details.');
    const crew = (det.credits && det.credits.crew) || [];
    const dir = crew.find(c => c.job === 'Director');
    addPicked = {
      posterPath: det.poster_path || null,
      movie: {
        id: det.imdb_id || `tmdb-${det.id}`,
        title: det.title || r.title,
        director: dir ? dir.name : '',
        year: det.release_date ? det.release_date.slice(0, 4) : '',
        actors: ((det.credits && det.credits.cast) || []).slice(0, 10).map(c => c.name),
        writers: extractWriters(crew),
        genre: det.genres && det.genres[0] ? det.genres[0].name : '',
      },
    };
    renderPick();
  } catch (err) {
    $a('addPickBox').innerHTML = '';
    addSay('Could not load details: ' + err.message);
  }
}

function renderPick() {
  const m = addPicked.movie;
  const img = addPicked.posterPath ? `<img src="${TMDB_IMG}w154${escapeHtml(addPicked.posterPath)}" alt="">` : '<div class="add-noimg big"></div>';
  $a('addPickBox').innerHTML = `
    <div class="add-pick">
      ${img}
      <div>
        <div class="r-title">${escapeHtml(m.title)} <span>(${escapeHtml(m.year)})</span></div>
        <div class="r-over">${escapeHtml(m.director ? 'Directed by ' + m.director : '')}${m.genre ? ' \u00b7 ' + escapeHtml(m.genre) : ''}</div>
      </div>
    </div>
    <div class="field"><label for="pickMedium">Medium</label>
      <input type="text" id="pickMedium" list="dlAddMedium" value="${escapeHtml(addLastMedium)}" placeholder="e.g. DVD" autocomplete="off"></div>
    <div class="field"><label for="pickCustom">Custom sort (optional)</label>
      <input type="text" id="pickCustom" placeholder="e.g. Has Fallen 4" autocomplete="off"></div>
    <div class="sheet-error" id="pickDup" style="color:var(--accent);"></div>
    <div class="sheet-actions">
      <button class="btn" onclick="addCommitPicked()">Add to collection</button>
      <button class="btn secondary" onclick="addCancelPick()">Cancel</button>
    </div>`;
  const dup = () => { $a('pickDup').textContent = dupWarning(m.id, $a('pickMedium').value); };
  $a('pickMedium').addEventListener('input', dup);
  dup();
  $a('pickMedium').focus();
}

// Drops the chosen film but keeps the search results so another can be picked.
function addCancelPick() {
  addPicked = null;
  $a('addPickBox').innerHTML = '';
  addSay('');
}

async function downloadPoster(posterPath) {
  try {
    const res = await fetch(`${TMDB_IMG}w300${posterPath}`);
    return res.ok ? await res.blob() : null;
  } catch (e) { return null; }
}

async function addCommitPicked() {
  const medium = $a('pickMedium').value.trim();
  if (!medium) { $a('pickDup').textContent = 'Choose a medium first.'; return; }
  const base = addPicked.movie;
  let cover = NO_POSTER_PATH, blob = null, note = '';

  if (addPicked.posterPath) {
    const path = `thumbs/${base.id}.jpg`;
    if (addCurrent.some(m => m.cover === path)) {
      cover = path; // another copy already has this cover; share it
    } else {
      blob = await downloadPoster(addPicked.posterPath);
      if (blob) cover = path; else note = ' (cover download failed, using the placeholder)';
    }
  }
  const movie = finalizeMovie({ ...base, medium, customSort: $a('pickCustom').value.trim() }, cover);
  await queueOp({ type: 'add', movie }, blob ? { path: cover, blob } : undefined);

  addLastMedium = medium;
  addPicked = null;
  addResultsList = [];
  $a('addResults').innerHTML = '';
  $a('addPickBox').innerHTML = '';
  $a('addQuery').value = '';
  $a('addYear').value = '';
  addSay(`Added "${movie.title}" (${medium})${note}. Push from the Backup panel at the top when you're ready.`);
  $a('addQuery').focus();
}

/* ---------- Manual entry ---------- */

function addToggleManual() {
  const box = $a('addManual');
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  const f = (id, label, extra = '') => `<div class="field"><label for="${id}">${label}</label><input type="text" id="${id}" ${extra} autocomplete="off"></div>`;
  box.innerHTML = `
    <div class="field-hint" style="margin:14px 0 8px;">For titles TMDB can't find. The cover is optional and gets shrunk to about 300px wide.</div>
    ${f('mTitle', 'Title')}
    ${f('mYear', 'Year', 'inputmode="numeric"')}
    ${f('mDirector', 'Director')}
    ${f('mGenre', 'Genre', 'list="dlAddGenre"')}
    ${f('mMedium', 'Medium', `list="dlAddMedium" value="${escapeHtml(addLastMedium)}"`)}
    ${f('mActors', 'Cast (comma separated)')}
    ${f('mCustom', 'Custom sort (optional)')}
    <div class="field"><label for="mCover">Cover image (optional)</label><input type="file" id="mCover" accept="image/*"></div>
    <div class="sheet-error" id="mMsg" style="color:var(--accent);"></div>
    <div class="sheet-actions">
      <button class="btn" onclick="addCommitManual()">Add to collection</button>
      <button class="btn secondary" onclick="addToggleManual()">Cancel</button>
    </div>`;
  box.style.display = 'block';
  const dup = () => {
    const t = $a('mTitle').value.trim();
    $a('mMsg').textContent = t ? dupWarning(`local-${slugify(t)}-${$a('mYear').value.trim()}`, $a('mMedium').value) : '';
  };
  ['mTitle', 'mYear', 'mMedium'].forEach(id => $a(id).addEventListener('input', dup));
  $a('mTitle').focus();
}

async function resizeToJpeg(file, maxW = 300) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not process that image.'))), 'image/jpeg', 0.85));
}

async function addCommitManual() {
  const title = $a('mTitle').value.trim();
  const medium = $a('mMedium').value.trim();
  if (!title || !medium) { $a('mMsg').textContent = 'Title and medium are required.'; return; }
  const year = $a('mYear').value.trim();
  const id = `local-${slugify(title)}-${year}`;
  const path = `thumbs/${id}.jpg`;

  let cover = NO_POSTER_PATH, blob = null;
  const file = $a('mCover').files[0];
  try {
    if (file) { blob = await resizeToJpeg(file); cover = path; }
    else if (addCurrent.some(m => m.cover === path)) cover = path;
  } catch (err) { $a('mMsg').textContent = err.message; return; }

  const movie = finalizeMovie({
    id, title, year, medium,
    director: $a('mDirector').value.trim(),
    genre: $a('mGenre').value.trim(),
    actors: $a('mActors').value.split(',').map(s => s.trim()).filter(Boolean),
    customSort: $a('mCustom').value.trim(),
  }, cover);
  await queueOp({ type: 'add', movie }, blob ? { path: cover, blob } : undefined);

  addLastMedium = medium;
  $a('addManual').style.display = 'none';
  addSay(`Added "${title}" (${medium}). Push from the Backup panel at the top when you're ready.`);
}

/* ---------- Wiring ---------- */

$a('addResults').addEventListener('click', (e) => {
  const row = e.target.closest('.add-result');
  if (row) addPickResult(+row.dataset.i);
});
['addQuery', 'addYear'].forEach(id => $a(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addSearch(); }));
document.addEventListener('syncchange', refreshAddContext);
refreshAddContext();