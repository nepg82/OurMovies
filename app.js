// Depends on shared.js and sync.js.

let BASE = [];   // data as loaded (site copy, or newer Git copy)
let MOVIES = []; // BASE with pending changes applied
let PEOPLE_INDEX = new Map(); // name -> [movie, ...]
let mode = 'movies';

const wall = document.getElementById('wall');
const alphaRail = document.getElementById('alphaRail');
const searchInput = document.getElementById('searchInput');
const countPill = document.getElementById('countPill');
const filterMedia = document.getElementById('filterMedia');
const filterGenre = document.getElementById('filterGenre');

const ALPHA = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function buildPeopleIndex() {
  PEOPLE_INDEX = new Map();
  for (const m of MOVIES) {
    const writerNames = (m.writers || []).map(w => w.name);
    const people = new Set([m.director, ...writerNames, ...(m.actors || [])].filter(Boolean));
    for (const name of people) {
      if (!PEOPLE_INDEX.has(name)) PEOPLE_INDEX.set(name, []);
      PEOPLE_INDEX.get(name).push(m);
    }
  }
}

async function loadData() {
  const { movies } = await syncInit();
  BASE = movies;
  await rebuild();
  checkGitOnStartup(); // runs in the background; may offer newer data
}

async function rebuild() {
  MOVIES = applyOps(BASE, await dbAll('ops'));
  buildPeopleIndex();
  renderAlphaRail();
  populateFilters();
  render();
  renderSyncIndicator();
}

document.addEventListener('syncchange', async (e) => {
  if (e.detail && e.detail.reload) BASE = (await syncInit()).movies;
  rebuild();
});

function populateFilters() {
  const mediums = [...new Set(MOVIES.map(m => m.medium).filter(Boolean))].sort();
  const genres = [...new Set(MOVIES.map(m => m.genre).filter(Boolean))].sort();
  const curMedia = filterMedia.value, curGenre = filterGenre.value;

  filterMedia.innerHTML = `<option value="">All media</option>` +
    mediums.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  filterGenre.innerHTML = `<option value="">All genres</option>` +
    genres.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');

  filterMedia.value = curMedia;
  filterGenre.value = curGenre;
  filterMedia.classList.toggle('filter-active', !!filterMedia.value);
  filterGenre.classList.toggle('filter-active', !!filterGenre.value);
}

filterMedia.addEventListener('change', () => filterMedia.classList.toggle('filter-active', !!filterMedia.value));
filterGenre.addEventListener('change', () => filterGenre.classList.toggle('filter-active', !!filterGenre.value));

function setMode(next) {
  mode = next;
  document.getElementById('tabMovies').classList.toggle('active', mode === 'movies');
  document.getElementById('tabPeople').classList.toggle('active', mode === 'people');
  searchInput.placeholder = mode === 'movies' ? 'Search titles...' : 'Search a person...';
  searchInput.value = '';
  alphaRail.style.display = mode === 'movies' ? 'flex' : 'none';
  filterMedia.disabled = mode !== 'movies';
  filterGenre.disabled = mode !== 'movies';
  render();
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  if (mode === 'movies') renderMovies(q);
  else renderPeople(q);
}

function renderMovies(query) {
  const mediaVal = filterMedia.value;
  const genreVal = filterGenre.value;

  // Search matches the real title only, never customSort.
  const list = MOVIES.filter(m => {
    const matchesQuery = !query || (m.title || '').toLowerCase().includes(query);
    const matchesMedia = !mediaVal || m.medium === mediaVal;
    const matchesGenre = !genreVal || m.genre === genreVal;
    return matchesQuery && matchesMedia && matchesGenre;
  });

  countPill.textContent = `${list.length} of ${MOVIES.length} in your collection`;

  if (list.length === 0) {
    wall.innerHTML = `<div class="empty-state"><div class="big">Nothing matches</div>Try a different title.</div>`;
    return;
  }

  // Group and order by the effective sort key so custom series order
  // also decides which letter a title files under.
  const groups = new Map();
  for (const m of list) {
    const l = letterOf(effectiveSort(m));
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(m);
  }

  const letters = [...groups.keys()].sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));

  wall.innerHTML = letters.map(letter => {
    const items = groups.get(letter).sort(compareMovies);
    const cards = items.map(cardHtml).join('');
    return `<div class="letter-heading" id="letter-${letter}">${letter}</div><div class="grid">${cards}</div>`;
  }).join('');
}

function cardHtml(m) {
  return `<div class="card" data-uid="${escapeHtml(m.uid)}">
    <img src="${escapeHtml(coverSrc(m))}" alt="${escapeHtml(m.title)} cover" loading="lazy">
    <div class="meta">
      <div class="t">${escapeHtml(m.title)}</div>
      <div class="y">${escapeHtml(m.year)} &middot; ${escapeHtml(m.medium)}</div>
    </div>
  </div>`;
}

wall.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) showDetail(card.dataset.uid);
});

/* --- Detail sheet --- */

function showDetail(uid) {
  const m = MOVIES.find(x => x.uid === uid);
  if (!m) return;
  closeDetail();

  const rows = [['Director', m.director], ['Genre', m.genre], ['Medium', m.medium]];
  for (const w of (m.writers || [])) rows.push([w.job, w.name]);
  if ((m.customSort || '').trim()) rows.push(['Sorts as', m.customSort]);

  const rowsHtml = rows
    .filter(r => r[1])
    .map(([k, v]) => `<div class="sheet-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('');

  const cast = (m.actors || []).length
    ? `<div class="sheet-cast"><div class="sheet-cast-label">Cast</div>${escapeHtml(m.actors.join(', '))}</div>`
    : '';

  const review = m.needsReview
    ? `<div class="sheet-review">Flagged for review: ${escapeHtml(m.needsReview)}</div>`
    : '';

  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.id = 'detailSheet';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(m.title)}">
      <button class="sheet-close" aria-label="Close">&times;</button>
      <div class="sheet-head">
        <img src="${escapeHtml(coverSrc(m))}" alt="">
        <div>
          <h2>${escapeHtml(m.title)}</h2>
          <div class="sheet-year">${escapeHtml(m.year)}</div>
        </div>
      </div>
      <dl class="sheet-rows">${rowsHtml}</dl>
      ${cast}
      ${review}
      ${ghReady() ? `<div class="sheet-actions" id="sheetActions">
        <button class="btn" data-act="edit">Edit</button>
        <button class="btn danger" data-act="delete">Delete</button>
      </div>` : ''}
    </div>`;

  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('.sheet-close')) return closeDetail();
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'edit') showEditForm(m);
    else if (act.dataset.act === 'delete') showDeleteConfirm(m);
    else if (act.dataset.act === 'cancel-delete') showDetail(m.uid);
    else if (act.dataset.act === 'confirm-delete') confirmDelete(m);
  });
  document.body.appendChild(el);
  document.body.classList.add('sheet-open');
  el.querySelector('.sheet-close').focus();
}

/* --- Edit / delete (shown only when a GitHub token is saved) --- */

function showDeleteConfirm(m) {
  const box = document.getElementById('sheetActions');
  box.classList.add('confirming');
  box.innerHTML = `
    <div class="sheet-text">Delete <strong>${escapeHtml(m.title)}</strong> (${escapeHtml(m.medium)}, ${escapeHtml(m.year)})?
      Its cover file is removed on the next push unless another record still uses it.</div>
    <button class="btn danger" data-act="confirm-delete">Delete</button>
    <button class="btn secondary" data-act="cancel-delete">Keep</button>`;
}

async function confirmDelete(m) {
  await queueDelete(m.uid);
  closeDetail();
}

function parseWriters(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf(':');
    return i === -1 ? { job: 'Writer', name: l } : { job: l.slice(0, i).trim() || 'Writer', name: l.slice(i + 1).trim() };
  }).filter(w => w.name);
}

function showEditForm(m) {
  const sheet = document.querySelector('#detailSheet .sheet');
  const distinct = (key) => [...new Set(MOVIES.map(x => x[key]).filter(Boolean))].sort();
  const opts = (arr) => arr.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
  const field = (id, label, val, extra = '') =>
    `<div class="field"><label for="${id}">${label}</label><input type="text" id="${id}" value="${escapeHtml(val)}" ${extra}></div>`;

  sheet.innerHTML = `
    <button class="sheet-close" aria-label="Close">&times;</button>
    <h2 class="sheet-title">Edit</h2>
    ${field('eTitle', 'Title', m.title || '')}
    <div class="field">
      <label for="eCustom">Custom sort</label>
      <input type="text" id="eCustom" value="${escapeHtml(m.customSort || '')}" placeholder="e.g. Has Fallen 1" autocomplete="off">
      <div class="field-hint" id="eCustomHint"></div>
    </div>
    ${field('eYear', 'Year', m.year || '', 'inputmode="numeric"')}
    ${field('eDirector', 'Director', m.director || '')}
    ${field('eGenre', 'Genre', m.genre || '', 'list="dlGenre"')}
    ${field('eMedium', 'Medium', m.medium || '', 'list="dlMedium"')}
    <datalist id="dlGenre">${opts(distinct('genre'))}</datalist>
    <datalist id="dlMedium">${opts(distinct('medium'))}</datalist>
    <div class="field"><label for="eActors">Cast (comma separated)</label>
      <textarea id="eActors" rows="3">${escapeHtml((m.actors || []).join(', '))}</textarea></div>
    <div class="field"><label for="eWriters">Writers (one per line, Job: Name)</label>
      <textarea id="eWriters" rows="3">${escapeHtml((m.writers || []).map(w => `${w.job}: ${w.name}`).join('\n'))}</textarea></div>
    <div class="sheet-error" id="eError"></div>
    <div class="sheet-actions">
      <button class="btn" id="eSave">Save</button>
      <button class="btn secondary" id="eCancel">Cancel</button>
    </div>`;

  const $ = (id) => sheet.querySelector('#' + id);
  const hint = () => {
    const custom = $('eCustom').value.trim();
    const title = $('eTitle').value.trim();
    const key = custom || (title === m.title ? (m.sortTitle || title) : sortTitleOf(title));
    $('eCustomHint').textContent = `Files under ${letterOf(key)}. Blank sorts by title; numbers sort naturally (2 before 10).`;
  };
  hint();
  $('eCustom').addEventListener('input', hint);
  $('eTitle').addEventListener('input', hint);
  $('eCancel').onclick = () => showDetail(m.uid);
  sheet.querySelector('.sheet-close').onclick = closeDetail;
  $('eTitle').focus();

  $('eSave').onclick = async () => {
    const next = {
      title: $('eTitle').value.trim(),
      customSort: $('eCustom').value.trim(),
      year: $('eYear').value.trim(),
      director: $('eDirector').value.trim(),
      genre: $('eGenre').value.trim(),
      medium: $('eMedium').value.trim(),
      actors: $('eActors').value.split(',').map(s => s.trim()).filter(Boolean),
      writers: parseWriters($('eWriters').value),
    };
    if (!next.title) { $('eError').textContent = 'Title can\u2019t be blank.'; return; }
    if (!next.medium) { $('eError').textContent = 'Medium can\u2019t be blank.'; return; }
    const changes = {};
    for (const k of Object.keys(next)) {
      const cur = m[k] == null ? (Array.isArray(next[k]) ? [] : '') : m[k];
      if (JSON.stringify(cur) !== JSON.stringify(next[k])) changes[k] = next[k];
    }
    if (!Object.keys(changes).length) return closeDetail();
    await queueOp({ type: 'edit', uid: m.uid, changes });
    closeDetail();
  };
}

function closeDetail() {
  const el = document.getElementById('detailSheet');
  if (el) el.remove();
  document.body.classList.remove('sheet-open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDetail();
});

/* --- People --- */

function renderPeople(query) {
  if (!query) {
    wall.innerHTML = `<div class="empty-state"><div class="big">Search for someone</div>Find every actor or director in your collection.</div>`;
    countPill.textContent = `${PEOPLE_INDEX.size} people in your collection`;
    return;
  }

  const names = [...PEOPLE_INDEX.keys()].sort((a, b) => a.localeCompare(b));
  const filtered = names.filter(n => n.toLowerCase().includes(query));

  if (filtered.length === 0) {
    wall.innerHTML = `<div class="empty-state"><div class="big">No one matches</div>Try a different name.</div>`;
    countPill.textContent = '';
    return;
  }

  countPill.textContent = `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`;
  wall.innerHTML = '<div class="person-list">' + filtered.map(name => {
    const movies = [...PEOPLE_INDEX.get(name)].sort(compareMovies);
    const titles = movies.map(m => `${m.title} (${m.year})`).join(', ');
    return `<div class="person-row">
      <span class="name">${escapeHtml(name)}</span><span class="owned-count">${movies.length} owned</span>
      <div class="owned-titles">${escapeHtml(titles)}</div>
    </div>`;
  }).join('') + '</div>';
}

/* --- Alphabet rail --- */

function renderAlphaRail() {
  const present = new Set(MOVIES.map(m => letterOf(effectiveSort(m))));
  alphaRail.innerHTML = ALPHA.map(l => {
    const has = present.has(l);
    return `<button ${has ? '' : 'disabled'} onclick="jumpTo('${l}')">${l}</button>`;
  }).join('');
}

function jumpTo(letter) {
  const el = document.getElementById(`letter-${letter}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

searchInput.addEventListener('input', render);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

loadData();
