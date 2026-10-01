// Unused cover finder: lists files in thumbs/ on GitHub that no record uses,
// lets you review them, then deletes the ones you confirm in one commit.
// Depends on shared.js and sync.js. Load after admin.js.

let orphanFiles = [];   // [{ path, size }]
let orphanHead = null;  // { sha, tree } of the commit the scan was based on

const $o = (id) => document.getElementById(id);
const orphanSay = (msg) => { $o('orphanStatus').textContent = msg || ''; };

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function orphanScan() {
  if (!ghReady()) { orphanSay('Save your GitHub settings first.'); return; }
  const btn = $o('orphanScanBtn');
  btn.disabled = true;
  orphanFiles = [];
  renderOrphans();
  try {
    orphanSay('Reading the repo...');
    const { branch } = ghConfig();
    const ref = await gh(`/git/ref/heads/${branch}`);
    const head = await gh(`/git/commits/${ref.object.sha}`);
    const tree = await gh(`/git/trees/${head.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('The repo is too large for GitHub to list in one piece. Scan stopped to stay safe.');

    const raw = await ghRaw('data.json');
    const gitMovies = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(gitMovies) || !gitMovies.length) {
      throw new Error("Couldn't read a non-empty data.json from the repo. Scan stopped so nothing is wrongly flagged.");
    }

    // "Used" = anything Git's data.json points at, plus anything this device
    // has pending (unpushed adds may reuse an existing cover).
    if (!SYNC.movies) await syncInit();
    const local = applyOps(SYNC.movies, await dbAll('ops'));
    const used = new Set([...gitMovies, ...local].map(m => m.cover).filter(Boolean));
    for (const c of await dbAll('covers')) used.add(c.path);

    const thumbs = tree.tree.filter(t => t.type === 'blob' && /^thumbs\/[^/]+$/.test(t.path) && !t.path.slice(7).startsWith('.'));
    orphanFiles = thumbs
      .filter(t => t.path !== NO_POSTER_PATH && !used.has(t.path))
      .map(t => ({ path: t.path, size: t.size || 0 }))
      .sort((a, b) => a.path.localeCompare(b.path));
    orphanHead = { sha: ref.object.sha, tree: head.tree.sha };

    const total = orphanFiles.reduce((n, f) => n + f.size, 0);
    orphanSay(orphanFiles.length
      ? `Checked ${thumbs.length} files in thumbs/. ${orphanFiles.length} unused (${fmtBytes(total)}). Untick anything you want to keep.`
      : `Checked ${thumbs.length} files in thumbs/. Every one is in use. Nothing to clean up.`);
    renderOrphans();
  } catch (err) {
    orphanSay('Scan failed: ' + err.message);
  }
  btn.disabled = false;
}

function renderOrphans() {
  const list = $o('orphanList');
  $o('orphanActions').style.display = orphanFiles.length ? 'flex' : 'none';
  if (!orphanFiles.length) { list.innerHTML = ''; return; }
  list.innerHTML = '<div class="orphan-list">' + orphanFiles.map(f =>
    `<label class="orphan-row"><input type="checkbox" checked data-path="${escapeHtml(f.path)}">
      <img src="${escapeHtml(f.path)}" alt="" loading="lazy">
      <span class="o-name">${escapeHtml(f.path.slice(7))}</span><span class="o-size">${fmtBytes(f.size)}</span></label>`
  ).join('') + '</div>';
  updateOrphanButton();
}

function pickedOrphans() {
  return [...$o('orphanList').querySelectorAll('input[type=checkbox]:checked')].map(i => i.dataset.path);
}

function updateOrphanButton() {
  const n = pickedOrphans().length;
  const btn = $o('orphanDeleteBtn');
  btn.textContent = `Delete ${n} selected file${n === 1 ? '' : 's'}`;
  btn.disabled = n === 0;
}

function orphanSelect(on) {
  $o('orphanList').querySelectorAll('input[type=checkbox]').forEach(i => { i.checked = on; });
  updateOrphanButton();
}

async function orphanDelete() {
  const picked = pickedOrphans();
  if (!picked.length) return;
  const bytes = orphanFiles.filter(f => picked.includes(f.path)).reduce((n, f) => n + f.size, 0);
  if (!confirm(`Delete ${picked.length} cover file${picked.length === 1 ? '' : 's'} (${fmtBytes(bytes)}) from GitHub in a single commit?\n\nGit history keeps them, so this can be undone.`)) return;

  const btn = $o('orphanDeleteBtn');
  btn.disabled = true;
  try {
    orphanSay('Deleting...');
    const { branch } = ghConfig();
    const ref = await gh(`/git/ref/heads/${branch}`);
    if (ref.object.sha !== orphanHead.sha) {
      throw new Error('The repo changed since you scanned (a push from another device?). Scan again before deleting.');
    }
    const tree = await gh('/git/trees', {
      method: 'POST',
      body: { base_tree: orphanHead.tree, tree: picked.map(path => ({ path, mode: '100644', type: 'blob', sha: null })) },
    });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: { message: `Remove ${picked.length} unused cover file${picked.length === 1 ? '' : 's'}`, tree: tree.sha, parents: [orphanHead.sha] },
    });
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha } });
    await evictCachedCovers(picked);

    orphanHead = { sha: commit.sha, tree: tree.sha };
    orphanFiles = orphanFiles.filter(f => !picked.includes(f.path));
    renderOrphans();
    orphanSay(`Deleted ${picked.length} file${picked.length === 1 ? '' : 's'}.` +
      (orphanFiles.length ? ` ${orphanFiles.length} left that you kept.` : '') +
      ' If you keep a local copy of the repo, pull before your next local commit.');
  } catch (err) {
    orphanSay('Delete failed: ' + err.message);
    btn.disabled = false;
  }
}

$o('orphanList').addEventListener('change', updateOrphanButton);
$o('orphanList').addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; // thumb not on this site copy
}, true);
