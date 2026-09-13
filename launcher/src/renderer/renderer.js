'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let pendingLauncherUpdate = null;
let ready = false;

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
};

function setProgress(pct) {
  $('bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function setPhase(text, rate) {
  $('phase').textContent = text;
  $('rate').textContent = rate || '';
}

function setPlayable(on, label) {
  ready = on;
  $('btnPlay').disabled = !on;
  $('btnPlay').textContent = label || 'PLAY';
}

async function refreshState() {
  state = await window.launcher.state();
  $('setPath').value = state.settings.installPath;
  $('setArch').value = state.settings.arch;
  $('setAfter').value = state.settings.afterLaunch;
  $('setAuto').checked = !!state.settings.autoCheck;
  $('cvArch').textContent = state.settings.arch === 'legacy-x86' ? 'Legacy 32 bits' : 'Modern 64 bits';
  $('launcherVersion').textContent = 'Launcher v' + state.settings.launcherVersion;
  if (!state.game.ok) setPhase(state.game.reason, '');
}

async function loadNews() {
  const res = await window.launcher.news();
  const box = $('newsList');
  if (!res.ok || !res.items.length) {
    box.innerHTML = '<p class="muted">' + (res.ok ? 'No news yet.' : 'News unavailable: ' + res.error) + '</p>';
    return;
  }
  box.innerHTML = '';
  for (const item of res.items) {
    const el = document.createElement('article');
    el.className = 'news-item';
    const h = document.createElement('h4');
    h.textContent = item.title || '';
    const t = document.createElement('time');
    t.textContent = item.date || '';
    const p = document.createElement('p');
    p.textContent = item.content || '';
    el.append(h, t, p);
    box.appendChild(el);
  }
}

async function loadStatus() {
  const res = await window.launcher.status();
  const chip = $('statusChip');
  if (!res.ok) {
    chip.className = 'chip down';
    $('statusText').textContent = 'Server unreachable';
    $('svLogin').textContent = $('svGame').textContent = '?';
    return;
  }
  const s = res.status;
  const mark = (el, up) => {
    el.textContent = up ? 'Online' : 'Offline';
    el.className = up ? 'up' : 'down';
  };
  mark($('svLogin'), s.login);
  mark($('svGame'), s.game);
  $('svPlayers').textContent = s.players == null ? '-' : String(s.players);
  chip.className = 'chip ' + (s.login && s.game ? 'up' : 'down');
  $('statusText').textContent = s.login && s.game ? 'Server online' : 'Server offline';
}

function onUpdateEvent({ type, payload }) {
  if (type === 'phase') {
    if (payload.version) $('cvVersion').textContent = payload.version;
    pendingLauncherUpdate = payload.launcherUpdate || pendingLauncherUpdate;

    if (payload.phase === 'ready') {
      setProgress(100);
      setPhase(payload.message, '');
      setPlayable(state && state.game.ok, pendingLauncherUpdate ? 'UPDATE LAUNCHER' : 'PLAY');
    } else if (payload.phase === 'error') {
      setPhase('Error: ' + payload.message, '');
      setPlayable(state && state.game.ok, 'PLAY ANYWAY');
    } else {
      setPlayable(false);
      setProgress(payload.phase === 'downloading' ? 0 : 3);
      setPhase(payload.message, payload.files ? payload.files + ' files, ' + fmtBytes(payload.bytes) : '');
    }
  } else if (type === 'verify') {
    setProgress((payload.checked / payload.total) * 100);
    setPhase('Verifying game files...', payload.checked + ' / ' + payload.total);
  } else if (type === 'progress') {
    setProgress(payload.totalBytes ? (payload.doneBytes / payload.totalBytes) * 100 : 0);
    setPhase(
      'Downloading ' + payload.doneFiles + ' / ' + payload.totalFiles + ' files',
      fmtBytes(payload.doneBytes) + ' / ' + fmtBytes(payload.totalBytes) + '  -  ' + fmtBytes(payload.bytesPerSecond) + '/s'
    );
  }
}

function wire() {
  $('btnMin').onclick = () => window.launcher.minimize();
  $('btnClose').onclick = () => window.launcher.close();

  $('btnPlay').onclick = async () => {
    if (pendingLauncherUpdate) {
      await window.launcher.selfUpdate(pendingLauncherUpdate);
      return;
    }
    try {
      await window.launcher.play();
    } catch (err) {
      setPhase('Could not start the game: ' + (err.message || err), '');
    }
  };

  $('btnSettings').onclick = () => $('settings').classList.remove('hidden');
  $('btnCloseSettings').onclick = () => $('settings').classList.add('hidden');
  $('btnFolder').onclick = () => window.launcher.openInstallPath();

  $('btnPickPath').onclick = async () => {
    const picked = await window.launcher.pickInstallPath();
    if (picked) await refreshState();
  };

  const persist = async () => {
    await window.launcher.setSettings({
      arch: $('setArch').value,
      afterLaunch: $('setAfter').value,
      autoCheck: $('setAuto').checked
    });
    await refreshState();
  };
  $('setArch').onchange = persist;
  $('setAfter').onchange = persist;
  $('setAuto').onchange = persist;

  $('btnRepair').onclick = async () => {
    $('settings').classList.add('hidden');
    await window.launcher.check({ full: true });
  };

  const open = (key) => () => {
    const url = state && state.settings[key];
    if (url) window.launcher.openExternal(url);
  };
  $('btnSite').onclick = open('siteUrl');
  $('btnRegister').onclick = open('registerUrl');
  $('btnDiscord').onclick = open('discordUrl');

  window.launcher.onEvent(onUpdateEvent);
}

(async function init() {
  wire();
  await refreshState();
  loadNews();
  loadStatus();
  setInterval(loadStatus, 60000);

  if (state.settings.autoCheck) {
    await window.launcher.check({});
  } else {
    setPhase('Auto-check disabled.', '');
    setProgress(100);
    setPlayable(state.game.ok);
  }
})();
