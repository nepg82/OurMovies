const NO_POSTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300">
  <rect width="200" height="300" fill="#1C2030"/>
  <rect x="6" y="6" width="188" height="288" fill="none" stroke="#E8A33D" stroke-width="1.5" stroke-opacity="0.35"/>
  <text x="100" y="150" text-anchor="middle" font-family="Work Sans, sans-serif" font-size="12" fill="#8B8D9B">No cover found</text>
</svg>`;

// Helpers (sortTitleOf, slugify, extractWriters, fetchJsonWithRetry) live in shared.js.
const CONCURRENCY = 8;

let importResults = null; // { movies: [...], zipBlob: Blob }
let importRunning = false;

function importLog(msg) {
  const el = document.getElementById('importLog');
  el.style.display = 'block';
  const time = new Date().toLocaleTimeString();
  el.textContent += `\n[${time}] ${msg}`;
  el.scrollTop = el.scrollHeight;
}

function setProgress(done, total, extra) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById('importProgress').style.display = 'block';
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${done} / ${total} processed${extra ? ' — ' + extra : ''}`;
}

async function processRow(row, tmdbKey) {
  const title = (row.Title || '').trim();
  const year = (row.Year || '').trim();
  const imdb = (row.IMDbID || '').trim();
  const csvDirector = (row.Director || '').trim();
  const csvGenre = (row.Genre || '').trim();
  const medium = (row.Medium || '').trim();
  const csvActors = (row.Actors || '').split(',').map(a => a.trim()).filter(Boolean);
  const priorReview = (row.NeedsReview || '').trim();

  const needsDirector = !csvDirector;
  const needsActors = csvActors.length === 0;
  const needsGenre = !csvGenre;
  const needsYear = !year;
  // Writers have no CSV column — they only ever come from TMDB, so a details
  // call is needed whenever there's a match, regardless of what the CSV had.
  const needsTextBackfill = true;

  let tmdbBasic = null; // result from /find or /search — has poster_path, id
  let matchMethod = null;
  let reviewReasons = [];

  if (imdb) {
    const data = await fetchJsonWithRetry(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdb)}?api_key=${tmdbKey}&external_source=imdb_id`
    );
    if (data && data.movie_results && data.movie_results.length) {
      tmdbBasic = data.movie_results[0];
      matchMethod = 'imdb_id';
    }
  }

  if (!tmdbBasic && title) {
    const q = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(title)}${year ? '&year=' + encodeURIComponent(year) : ''}`;
    const data = await fetchJsonWithRetry(q);
    if (data && data.results && data.results.length) {
      tmdbBasic = data.results[0];
      matchMethod = 'title_search';
    }
  }

  if (tmdbBasic && matchMethod === 'title_search') {
    reviewReasons.push('matched by title search, not IMDb ID — verify');
  }
  if (!tmdbBasic) {
    reviewReasons.push('no TMDB match found');
  }

  // Only spend a second call on the rows that actually need backfilling —
  // everything else keeps the CSV's own director/actors/genre/year untouched.
  let finalDirector = csvDirector, finalActors = csvActors, finalGenre = csvGenre, finalYear = year, finalWriters = [];
  if (tmdbBasic && needsTextBackfill) {
    const det = await fetchJsonWithRetry(
      `https://api.themoviedb.org/3/movie/${tmdbBasic.id}?api_key=${tmdbKey}&append_to_response=credits`
    );
    if (det) {
      const filled = [];
      if (needsDirector) {
        const d = det.credits && det.credits.crew ? det.credits.crew.find(c => c.job === 'Director') : null;
        if (d) { finalDirector = d.name; filled.push('director'); }
      }
      if (needsActors && det.credits && det.credits.cast && det.credits.cast.length) {
        finalActors = det.credits.cast.slice(0, 10).map(c => c.name);
        filled.push('actors');
      }
      if (needsGenre && det.genres && det.genres[0]) {
        finalGenre = det.genres[0].name;
        filled.push('genre');
      }
      if (needsYear && det.release_date) {
        finalYear = det.release_date.slice(0, 4);
        filled.push('year');
      }
      if (det.credits && det.credits.crew) {
        finalWriters = extractWriters(det.credits.crew);
        if (finalWriters.length) filled.push('writers');
      }
      if (filled.length) reviewReasons.push(`backfilled from TMDB: ${filled.join(', ')} — verify`);
    }
  }

  const posterPath = tmdbBasic ? tmdbBasic.poster_path : null;
  if (!posterPath) reviewReasons.push('no cover art available');

  const id = imdb || (tmdbBasic ? `tmdb-${tmdbBasic.id}` : `local-${slugify(title)}-${year}`);
  const coverFile = posterPath ? `thumbs/${id}.jpg` : 'thumbs/_no-poster.svg';

  let posterBlob = null;
  if (posterPath) {
    try {
      const imgRes = await fetch(`https://image.tmdb.org/t/p/w300${posterPath}`);
      if (imgRes.ok) posterBlob = await imgRes.blob();
      else reviewReasons.push('cover art download failed');
    } catch (e) {
      reviewReasons.push('cover art download failed');
    }
  }

  const allReview = [priorReview, ...reviewReasons].filter(Boolean).join('; ');

  return {
    movie: {
      id,
      title,
      sortTitle: sortTitleOf(title),
      director: finalDirector,
      year: finalYear,
      actors: finalActors,
      writers: finalWriters,
      genre: finalGenre,
      medium,
      cover: coverFile,
      needsReview: allReview,
    },
    posterBlob,
    coverFile,
  };
}

async function runPool(items, worker, onProgress) {
  let idx = 0;
  let done = 0;
  const results = new Array(items.length);

  async function next() {
    while (idx < items.length) {
      const myIdx = idx++;
      try {
        results[myIdx] = await worker(items[myIdx]);
      } catch (err) {
        if (err.isAuthError) throw err;
        results[myIdx] = { movie: null, error: err.message };
      }
      done++;
      onProgress(done, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, next);
  await Promise.all(workers);
  return results;
}

function startImport() {
  if (importRunning) return;
  const fileInput = document.getElementById('importFile');
  const tmdbKey = localStorage.getItem('movieShelf_tmdbKey');

  if (!tmdbKey) {
    importLog('No TMDB key saved — open the TMDB section above and save your key first.');
    return;
  }
  if (!fileInput.files.length) {
    importLog('Choose a CSV file first.');
    return;
  }

  document.getElementById('importLog').textContent = '';
  document.getElementById('importDownloadBtn').style.display = 'none';
  importLog('Reading CSV...');

  Papa.parse(fileInput.files[0], {
    header: true,
    skipEmptyLines: true,
    complete: (parsed) => runImport(parsed.data, tmdbKey),
    error: (err) => importLog('CSV parse error: ' + err.message),
  });
}

async function runImport(rows, tmdbKey) {
  importRunning = true;
  document.getElementById('importStartBtn').disabled = true;
  importLog(`Parsed ${rows.length} rows. Starting lookups (this can take several minutes — keep this tab open)...`);
  setProgress(0, rows.length);

  let results;
  try {
    results = await runPool(rows, (row) => processRow(row, tmdbKey), (done, total) => {
      setProgress(done, total);
    });
  } catch (err) {
    if (err.isAuthError) {
      importLog('Stopped: ' + err.message + ' Double-check the key in the TMDB section above.');
    } else {
      importLog('Stopped: ' + err.message);
    }
    importRunning = false;
    document.getElementById('importStartBtn').disabled = false;
    return;
  }

  const movies = [];
  const zip = new JSZip();
  const thumbs = zip.folder('thumbs');
  thumbs.file('_no-poster.svg', NO_POSTER_SVG);

  let matched = 0, flagged = 0, noPoster = 0;

  for (const r of results) {
    if (!r || !r.movie) continue;
    movies.push(r.movie);
    if (r.movie.needsReview) flagged++;
    if (!r.movie.needsReview.includes('no TMDB match')) matched++;
    if (r.posterBlob) {
      thumbs.file(r.coverFile.replace('thumbs/', ''), r.posterBlob);
    } else {
      noPoster++;
    }
  }

  movies.sort((a, b) => (a.sortTitle || '').toLowerCase().localeCompare((b.sortTitle || '').toLowerCase()));

  zip.file('data.json', JSON.stringify(movies, null, 2));

  importLog(`Done. ${matched} matched to TMDB, ${flagged} flagged for review, ${noPoster} missing cover art.`);
  importLog('Packaging zip...');

  const blob = await zip.generateAsync({ type: 'blob' });
  importResults = { blob };

  importLog('Zip ready — click "Download result".');
  document.getElementById('importDownloadBtn').style.display = 'inline-block';
  importRunning = false;
  document.getElementById('importStartBtn').disabled = false;
}

function downloadImportZip() {
  if (!importResults) return;
  const url = URL.createObjectURL(importResults.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ourmovies-import.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
