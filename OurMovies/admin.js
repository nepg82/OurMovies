const FIELDS = {
  tmdbKey: 'movieShelf_tmdbKey',
  upcKey: 'movieShelf_upcKey',
  ghToken: 'movieShelf_ghToken',
  ghOwner: 'movieShelf_ghOwner',
  ghRepo: 'movieShelf_ghRepo',
  ghBranch: 'movieShelf_ghBranch',
};

function loadSaved() {
  for (const [inputId, storageKey] of Object.entries(FIELDS)) {
    const val = localStorage.getItem(storageKey);
    if (val) document.getElementById(inputId).value = val;
  }
  updateDot('dotTmdb', !!localStorage.getItem(FIELDS.tmdbKey));
  updateDot('dotUpc', !!localStorage.getItem(FIELDS.upcKey));
  updateDot('dotGithub', !!localStorage.getItem(FIELDS.ghToken) && !!localStorage.getItem(FIELDS.ghOwner) && !!localStorage.getItem(FIELDS.ghRepo));
}

function updateDot(dotId, isSet) {
  document.getElementById(dotId).classList.toggle('set', isSet);
}

function saveField(inputId, dotId) {
  const val = document.getElementById(inputId).value.trim();
  localStorage.setItem(FIELDS[inputId], val);
  updateDot(dotId, !!val);
  flashMsg(dotId === 'dotTmdb' ? 'msgTmdb' : 'msgUpc');
}

function saveGithub() {
  ['ghToken', 'ghOwner', 'ghRepo', 'ghBranch'].forEach(id => {
    localStorage.setItem(FIELDS[id], document.getElementById(id).value.trim());
  });
  const ok = !!localStorage.getItem(FIELDS.ghToken) && !!localStorage.getItem(FIELDS.ghOwner) && !!localStorage.getItem(FIELDS.ghRepo);
  updateDot('dotGithub', ok);
  flashMsg('msgGithub');
}

function flashMsg(id) {
  const el = document.getElementById(id);
  el.textContent = 'Saved.';
  setTimeout(() => { el.textContent = ''; }, 2000);
}

function log(msg) {
  const el = document.getElementById('debugLog');
  const time = new Date().toLocaleTimeString();
  el.textContent += `\n[${time}] ${msg}`;
  el.scrollTop = el.scrollHeight;
}

async function refreshFromGit() {
  document.getElementById('debugLog').textContent = '';
  log('Starting refresh...');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        await r.unregister();
      }
      log(`Unregistered ${regs.length} service worker(s).`);
    } else {
      log('No service worker support in this browser.');
    }

    if ('caches' in window) {
      const names = await caches.keys();
      for (const n of names) {
        await caches.delete(n);
      }
      log(`Cleared ${names.length} cache(s).`);
    }

    log('Reloading from GitHub Pages...');
    setTimeout(() => {
      // cache-bust query param forces a real network fetch of index.html itself
      window.location.href = window.location.pathname.replace('admin.html', 'index.html') + '?refresh=' + Date.now();
    }, 400);
  } catch (err) {
    log('Error: ' + err.message);
  }
}

loadSaved();
