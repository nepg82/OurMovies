// One-off backfill: adds `writers` to movies that were imported before that
// field existed. Reuses fetchJsonWithRetry() and runPool() from import.js —
// make sure import.js is loaded on the page before this file.

let migrateResults = null;
let migrateRunning = false;

function migrateLog(msg) {
  const el = document.getElementById('migrateLog');
  el.style.display = 'block';
  const time = new Date().toLocaleTimeString();
  el.textContent += `\n[${time}] ${msg}`;
  el.scrollTop = el.scrollHeight;
}

function setMigrateProgress(done, total, extra) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById('migrateProgress').style.display = 'block';
  document.getElementById('migrateProgressFill').style.width = pct + '%';
  document.getElementById('migrateProgressText').textContent = `${done} / ${total} processed${extra ? ' — ' + extra : ''}`;
}

// Figures out a TMDB movie id for an existing record, using whatever id
// scheme it was originally saved with:
//   tt.......   -> IMDb id, resolved via TMDB's /find endpoint
//   tmdb-12345  -> TMDB id already known, no lookup needed
//   local-...   -> never matched TMDB during the original import;
//                  fall back to the same title/year search import.js uses
async function findTmdbIdForMovie(m, tmdbKey) {
  if (/^tt\d+/.test(m.id)) {
    const data = await fetchJsonWithRetry(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(m.id)}?api_key=${tmdbKey}&external_source=imdb_id`
    );
    if (data && data.movie_results && data.movie_results.length) {
      return data.movie_results[0].id;
    }
    return null;
  }
  if (m.id.startsWith('tmdb-')) {
    return m.id.slice('tmdb-'.length);
  }
  if (m.title) {
    const q = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(m.title)}${m.year ? '&year=' + encodeURIComponent(m.year) : ''}`;
    const data = await fetchJsonWithRetry(q);
    if (data && data.results && data.results.length) {
      return data.results[0].id;
    }
  }
  return null;
}

async function migrateOneMovie(m, tmdbKey) {
  if (m.writers && m.writers.length) {
    return { movie: m, skipped: true };
  }
  const tmdbId = await findTmdbIdForMovie(m, tmdbKey);
  if (!tmdbId) {
    return { movie: { ...m, writers: m.writers || [] }, matched: false };
  }
  const det = await fetchJsonWithRetry(
    `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}&append_to_response=credits`
  );
  if (!det || !det.credits) {
    return { movie: { ...m, writers: m.writers || [] }, matched: false };
  }
  const writers = extractWriters(det.credits.crew);
  return { movie: { ...m, writers }, matched: true, foundWriters: writers.length > 0 };
}

function startMigration() {
  if (migrateRunning) return;
  const tmdbKey = localStorage.getItem('movieShelf_tmdbKey');
  if (!tmdbKey) {
    migrateLog('No TMDB key saved — open the TMDB section above and save your key first.');
    return;
  }

  document.getElementById('migrateLog').textContent = '';
  document.getElementById('migrateDownloadBtn').style.display = 'none';
  migrateLog('Fetching current data.json...');

  fetch('data.json')
    .then(r => r.json())
    .then(movies => runMigration(movies, tmdbKey))
    .catch(err => migrateLog('Failed to load data.json: ' + err.message));
}

async function runMigration(movies, tmdbKey) {
  migrateRunning = true;
  document.getElementById('migrateStartBtn').disabled = true;
  migrateLog(`Loaded ${movies.length} movies. Looking up writing credits (this can take a few minutes — keep this tab open)...`);
  setMigrateProgress(0, movies.length);

  let results;
  try {
    results = await runPool(movies, (m) => migrateOneMovie(m, tmdbKey), (done, total) => {
      setMigrateProgress(done, total);
    });
  } catch (err) {
    if (err.isAuthError) {
      migrateLog('Stopped: ' + err.message + ' Double-check the key in the TMDB section above.');
    } else {
      migrateLog('Stopped: ' + err.message);
    }
    migrateRunning = false;
    document.getElementById('migrateStartBtn').disabled = false;
    return;
  }

  const updated = [];
  let added = 0, noWriters = 0, noMatch = 0, skipped = 0;

  for (const r of results) {
    if (!r || !r.movie) continue;
    updated.push(r.movie);
    if (r.skipped) { skipped++; continue; }
    if (!r.matched) { noMatch++; continue; }
    if (r.foundWriters) added++; else noWriters++;
  }

  migrateLog(`Done. ${added} movies got writer credits, ${noWriters} matched TMDB but had no writing crew listed, ${noMatch} couldn't be matched to TMDB, ${skipped} already had writers and were left alone.`);
  migrateLog('Download the updated data.json below, then replace the file in your repo and commit — the site will pick it up on next load.');

  migrateResults = { blob: new Blob([JSON.stringify(updated, null, 2)], { type: 'application/json' }) };
  document.getElementById('migrateDownloadBtn').style.display = 'inline-block';
  migrateRunning = false;
  document.getElementById('migrateStartBtn').disabled = false;
}

function downloadMigratedData() {
  if (!migrateResults) return;
  const url = URL.createObjectURL(migrateResults.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
