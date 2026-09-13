let MOVIES = [];
let PEOPLE_INDEX = new Map(); // name -> [movie, ...]
let mode = 'movies';

const wall = document.getElementById('wall');
const alphaRail = document.getElementById('alphaRail');
const searchInput = document.getElementById('searchInput');
const countPill = document.getElementById('countPill');

const ALPHA = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function letterOf(sortTitle) {
  const c = sortTitle[0].toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

function buildPeopleIndex() {
  PEOPLE_INDEX = new Map();
  for (const m of MOVIES) {
    const people = new Set([m.director, ...(m.actors || [])].filter(Boolean));
    for (const name of people) {
      if (!PEOPLE_INDEX.has(name)) PEOPLE_INDEX.set(name, []);
      PEOPLE_INDEX.get(name).push(m);
    }
  }
}

async function loadData() {
  const res = await fetch('data.json');
  MOVIES = await res.json();
  buildPeopleIndex();
  renderAlphaRail();
  render();
}

function setMode(next) {
  mode = next;
  document.getElementById('tabMovies').classList.toggle('active', mode === 'movies');
  document.getElementById('tabPeople').classList.toggle('active', mode === 'people');
  searchInput.placeholder = mode === 'movies' ? 'Search titles...' : 'Search a person...';
  searchInput.value = '';
  alphaRail.style.display = mode === 'movies' ? 'flex' : 'none';
  render();
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  if (mode === 'movies') renderMovies(q);
  else renderPeople(q);
}

function renderMovies(query) {
  let list = MOVIES;
  if (query) {
    list = MOVIES.filter(m => m.title.toLowerCase().includes(query));
  }
  countPill.textContent = `${list.length} of ${MOVIES.length} in your collection`;

  if (list.length === 0) {
    wall.innerHTML = `<div class="empty-state"><div class="big">Nothing matches</div>Try a different title.</div>`;
    return;
  }

  const groups = new Map();
  for (const m of list) {
    const l = letterOf(m.sortTitle);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(m);
  }

  const letters = [...groups.keys()].sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));

  wall.innerHTML = letters.map(letter => {
    const items = groups.get(letter).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    const cards = items.map(cardHtml).join('');
    return `<div class="letter-heading" id="letter-${letter}">${letter}</div><div class="grid">${cards}</div>`;
  }).join('');
}

function cardHtml(m) {
  return `<div class="card" onclick="showDetail('${m.id}')">
    <img src="${m.cover}" alt="${escapeHtml(m.title)} cover" loading="lazy">
    <div class="meta">
      <div class="t">${escapeHtml(m.title)}</div>
      <div class="y">${m.year} &middot; ${m.medium}</div>
    </div>
  </div>`;
}

function showDetail(id) {
  const m = MOVIES.find(x => x.id === id);
  if (!m) return;
  alert(`${m.title} (${m.year})\n\nDirector: ${m.director}\nGenre: ${m.genre}\nMedium: ${m.medium}\n\nCast: ${(m.actors || []).join(', ')}`);
}

function renderPeople(query) {
  const names = [...PEOPLE_INDEX.keys()].sort((a, b) => a.localeCompare(b));
  const filtered = query ? names.filter(n => n.toLowerCase().includes(query)) : (query === '' ? [] : names);

  if (!query) {
    wall.innerHTML = `<div class="empty-state"><div class="big">Search for someone</div>Find every actor or director in your collection.</div>`;
    countPill.textContent = `${PEOPLE_INDEX.size} people in your collection`;
    return;
  }

  if (filtered.length === 0) {
    wall.innerHTML = `<div class="empty-state"><div class="big">No one matches</div>Try a different name.</div>`;
    countPill.textContent = '';
    return;
  }

  countPill.textContent = `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`;
  wall.innerHTML = '<div class="person-list">' + filtered.map(name => {
    const movies = PEOPLE_INDEX.get(name).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    const titles = movies.map(m => `${m.title} (${m.year})`).join(', ');
    return `<div class="person-row">
      <span class="name">${escapeHtml(name)}</span><span class="owned-count">${movies.length} owned</span>
      <div class="owned-titles">${escapeHtml(titles)}</div>
    </div>`;
  }).join('') + '</div>';
}

function renderAlphaRail() {
  const present = new Set(MOVIES.map(m => letterOf(m.sortTitle)));
  alphaRail.innerHTML = ALPHA.map(l => {
    const has = present.has(l);
    return `<button ${has ? '' : 'disabled'} onclick="jumpTo('${l}')">${l}</button>`;
  }).join('');
}

function jumpTo(letter) {
  const el = document.getElementById(`letter-${letter}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

searchInput.addEventListener('input', render);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

loadData();
