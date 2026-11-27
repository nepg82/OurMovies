// Missing genre / medium report (Admin page).
// Depends on shared.js and sync.js; PapaParse is already loaded by admin.html.

(function () {
  let rows = []; // [{ m, missing: ['Genre', 'Medium'] }]
  let built = false;

  const isBlank = (v) => v == null || String(v).trim() === '';
  const el = (id) => document.getElementById(id);

  async function buildMissingReport() {
    const btn = el('reportBtn');
    const status = el('reportStatus');
    const list = el('reportList');
    const actions = el('reportActions');
    const checkGenre = el('reportGenre').checked;
    const checkMedium = el('reportMedium').checked;

    list.innerHTML = '';
    actions.style.display = 'none';
    if (!checkGenre && !checkMedium) {
      rows = [];
      status.textContent = 'Pick at least one field to check.';
      return;
    }
    btn.disabled = true;
    status.textContent = 'Checking\u2026';

    try {
      // Same view of the collection the shelf shows: loaded data plus unpushed changes.
      const base = (SYNC.movies && SYNC.movies.length) ? SYNC.movies : (await syncInit()).movies;
      const movies = applyOps(base, await dbAll('ops'));
      const pending = await getPendingCount();

      rows = [];
      for (const m of movies) {
        const missing = [];
        if (checkGenre && isBlank(m.genre)) missing.push('Genre');
        if (checkMedium && isBlank(m.medium)) missing.push('Medium');
        if (missing.length) rows.push({ m, missing });
      }
      rows.sort((a, b) => compareMovies(a.m, b.m));

      const noGenre = rows.filter(r => r.missing.includes('Genre')).length;
      const noMedium = rows.filter(r => r.missing.includes('Medium')).length;
      const both = rows.filter(r => r.missing.length === 2).length;

      const parts = [`${movies.length} records checked`];
      if (rows.length) {
        const counts = [];
        if (checkGenre) counts.push(`${noGenre} missing genre`);
        if (checkMedium) counts.push(`${noMedium} missing medium`);
        let text = counts.join(', ');
        if (checkGenre && checkMedium && both) text += ` (${both} missing both)`;
        parts.push(text);
      } else {
        const what = checkGenre && checkMedium ? 'a genre or medium' : checkGenre ? 'a genre' : 'a medium';
        parts.push(`none are missing ${what}`);
      }
      if (pending) parts.push(`includes ${pending} unpushed change${pending === 1 ? '' : 's'}`);
      status.textContent = parts.join(' \u00b7 ');

      if (rows.length) {
        list.innerHTML = '<div class="orphan-list">' + rows.map(({ m, missing }) => {
          const label = escapeHtml(m.title || '(untitled)') + (m.year ? ` (${escapeHtml(m.year)})` : '');
          return `<div class="orphan-row" style="cursor:default" title="${escapeHtml(m.uid || '')}">` +
            `<span class="o-name">${label}</span><span class="o-size">${missing.join(' + ')}</span></div>`;
        }).join('') + '</div>';
        actions.style.display = 'flex';
      }
      built = true;
    } catch (err) {
      status.textContent = 'Could not build the report: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function downloadMissingReportCsv() {
    if (!rows.length) return;
    const data = rows.map(({ m, missing }) => ({
      Title: m.title || '',
      Year: m.year || '',
      ID: m.id || '',
      UID: m.uid || '',
      Genre: m.genre || '',
      Medium: m.medium || '',
      Missing: missing.join(' + '),
    }));
    const blob = new Blob([Papa.unparse(data)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `missing-genre-medium-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Once a report exists, changing a checkbox re-runs it so the list never goes stale.
  ['reportGenre', 'reportMedium'].forEach(id =>
    el(id).addEventListener('change', () => { if (built) buildMissingReport(); }));

  window.buildMissingReport = buildMissingReport;
  window.downloadMissingReportCsv = downloadMissingReportCsv;
})();
