// app.js — screens, navigation, and glue. Plain JavaScript, no framework.
//
// Navigation is hash-based (#/companies, #/company/<id>, ...) so the whole
// app is one cached HTML file that works as an installed PWA.

import { api, hasCreds, saveCreds, clearCreds, getCreds, createRow, updateRow, softDelete } from './api.js';
import { getAll, getById, getByIndex, putRow, counts, clearAll, kvGet } from './db.js';
import { fullLoad, syncNow, syncSoon, syncState, onSyncChange, lastSyncTime } from './sync.js';

const $view = document.getElementById('view');
const $tabbar = document.getElementById('tabbar');
const $syncdot = document.getElementById('syncdot');

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function agoLabel(iso) {
  const n = daysAgo(iso);
  if (n === null) return 'never';
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 30) return n + ' days ago';
  if (n < 365) return Math.floor(n / 30) + ' mo ago';
  return Math.floor(n / 365) + ' yr ago';
}

// green = touched in 30 days, yellow = 90, red = colder (spec §6.1)
function recencyClass(iso) {
  const n = daysAgo(iso);
  if (n === null) return 'cold';
  if (n <= 30) return 'fresh';
  if (n <= 90) return 'warm';
  return 'cold';
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

function nowLocalInput() {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' toast-err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, isError ? 5000 : 2200);
}

async function tryWrite(fn, okMsg) {
  try {
    const result = await fn();
    if (okMsg) toast(okMsg);
    syncSoon(); // pull server-side effects (updatedAt, lastActivityAt)
    return result;
  } catch (err) {
    toast(err.message + (err.kind === 'network' ? ' — change NOT saved, try again when back online.' : ''), true);
    return null;
  }
}

const ACTIVITY_TYPES = ['call', 'visit', 'email', 'meeting', 'note'];
const TYPE_ICONS = { call: '📞', visit: '🚗', email: '✉️', meeting: '🤝', note: '📝' };

// ---------------------------------------------------------------- router

const routes = [
  [/^#\/setup$/, viewSetup],
  [/^#\/map$/, viewMap],
  [/^#\/companies$/, viewCompanies],
  [/^#\/company\/new$/, () => viewCompanyForm(null)],
  [/^#\/company\/([^/]+)\/edit$/, m => viewCompanyForm(m[1])],
  [/^#\/company\/([^/]+)\/log$/, m => viewActivityForm(m[1])],
  [/^#\/company\/([^/]+)\/contact\/new$/, m => viewContactForm(null, m[1])],
  [/^#\/contact\/([^/]+)\/edit$/, m => viewContactForm(m[1], null)],
  [/^#\/company\/([^/]+)$/, m => viewCompany(m[1])],
  [/^#\/followups$/, viewFollowups],
  [/^#\/settings$/, viewSettings],
];

async function render() {
  if (!hasCreds() && location.hash !== '#/setup') {
    location.hash = '#/setup';
    return;
  }
  if (leafletMap) { leafletMap.remove(); leafletMap = null; } // tear down map on view change
  const hash = location.hash || '#/map';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      $tabbar.style.display = hash === '#/setup' ? 'none' : '';
      highlightTab(hash);
      try {
        await fn(m);
      } catch (err) {
        $view.innerHTML = `<div class="pad"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
      }
      return;
    }
  }
  location.hash = '#/map';
}

function highlightTab(hash) {
  for (const a of $tabbar.querySelectorAll('a')) {
    a.classList.toggle('active', hash.startsWith(a.getAttribute('href')));
  }
}

// ---------------------------------------------------------------- setup

async function viewSetup() {
  const c = getCreds();
  $view.innerHTML = `
  <div class="pad setup">
    <h1>FieldRep CRM</h1>
    <p>Connect this device to your database. You need the two secrets from the
       backend setup — they are saved only on this device.</p>
    <label>Web App URL (ends in /exec)
      <input type="url" id="su-url" value="${esc(c.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
    </label>
    <label>API token
      <input type="password" id="su-token" value="${esc(c.token)}" placeholder="paste your token" autocomplete="off">
    </label>
    <button class="btn primary" id="su-go">Connect &amp; download data</button>
    <p id="su-status" class="muted"></p>
  </div>`;

  document.getElementById('su-go').onclick = async () => {
    // Tolerate messy pastes: pull the /exec URL out of surrounding text and
    // undo iOS "smart" dashes; strip anything impossible from the token.
    const rawUrl = document.getElementById('su-url').value.replace(/[‐-―−]/g, '-');
    const urlMatch = rawUrl.match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/);
    const url = urlMatch ? urlMatch[0] : '';
    const token = document.getElementById('su-token').value.replace(/[^A-Za-z0-9_-]/g, '');
    const status = document.getElementById('su-status');
    if (!url) {
      status.textContent = 'That doesn’t contain a complete Web App URL. Copy the whole link — it starts with https://script.google.com/macros/s/ and ends in /exec.';
      return;
    }
    if (token.length < 20) {
      status.textContent = 'The token looks too short — copy the whole 64-character token.';
      return;
    }
    document.getElementById('su-url').value = url; // show what will be used
    saveCreds(url, token);
    status.textContent = 'Testing connection…';
    try {
      await api('sync', { since: new Date().toISOString() });
    } catch (err) {
      clearCreds();
      // keep what was typed so a typo is fixable without re-pasting everything
      saveCreds(url, token); clearIfAuthFailed(err);
      status.textContent =
        err.message.includes('404') ? 'Google says that address doesn’t exist (404) — the URL is damaged or incomplete. Re-copy the /exec link and paste again.'
        : err.kind === 'auth' ? 'The server rejected the token — re-copy the 64-character token and paste again.'
        : 'Connection failed: ' + err.message;
      return;
    }
    status.textContent = 'Connected. Downloading your database (first time only)…';
    const stopProgress = onSyncChange(() => {
      if (syncState.progress) status.textContent = 'Downloading… ' + syncState.progress;
    });
    try {
      await fullLoad();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      const n = await counts();
      status.textContent = `Done — ${n.companies} companies, ${n.contacts} contacts, ${n.activities} activities.`;
      setTimeout(() => { location.hash = '#/companies'; }, 600);
    } catch (err) {
      status.textContent = 'Download failed: ' + err.message + ' — tap the button to resume; already-downloaded rows are kept.';
    } finally {
      stopProgress();
    }
  };

  function clearIfAuthFailed(err) {
    if (err.kind === 'auth') clearCreds();
  }
}

// ---------------------------------------------------------------- map (spec §6.1)

const mapState = { center: null, zoom: null, colorMode: 'recency', radiusMi: 25 };
let leafletMap = null; // torn down whenever the view is left

const RECENCY_COLORS = { fresh: '#2e9e44', warm: '#e0a800', cold: '#d0453a' };
const GROUP_PALETTE = ['#1668b8', '#2e9e44', '#e0a800', '#d0453a', '#7b3fb3', '#0e8a86', '#b35f1d', '#5c6b7a'];

function groupColor(group) {
  const key = (group || '').split(';')[0].trim().toLowerCase();
  if (!key) return '#5c6b7a';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return GROUP_PALETTE[h % GROUP_PALETTE.length];
}

function pinColor(c) {
  return mapState.colorMode === 'group'
    ? groupColor(c.group)
    : RECENCY_COLORS[recencyClass(c.lastActivityAt)];
}

function milesBetween(lat1, lng1, lat2, lng2) {
  const rad = x => x * Math.PI / 180, R = 3958.8; // haversine, Earth radius in miles
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function viewMap() {
  const companies = (await getAll('companies')).filter(c => c.lat && c.lng);

  $view.innerHTML = `
  <div id="mapwrap">
    <div id="map"></div>
    <div class="mapbar">
      <div class="mapmode" id="mapmode">
        <button data-mode="recency" class="${mapState.colorMode === 'recency' ? 'active' : ''}">Activity</button>
        <button data-mode="group" class="${mapState.colorMode === 'group' ? 'active' : ''}">Group</button>
      </div>
      <button class="btn small" id="nearme">📍 Near me</button>
    </div>
    <div class="maplegend" id="maplegend"></div>
    <div id="nearpanel" hidden></div>
  </div>`;

  const map = L.map('map', { zoomControl: false });
  leafletMap = map;
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (map &amp; geocoding)',
  }).addTo(map);

  let cluster = null;
  const drawPins = () => {
    if (cluster) map.removeLayer(cluster);
    cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 55 });
    for (const c of companies) {
      const m = L.circleMarker([Number(c.lat), Number(c.lng)], {
        radius: c.priority === 'A' ? 10 : 7,
        color: '#ffffff', weight: 1.5,
        fillColor: pinColor(c), fillOpacity: 0.92,
      });
      m.bindPopup(`
        <div class="pin-pop">
          <a class="pin-name" href="#/company/${esc(c.id)}">${esc(c.name)}</a>
          <div class="pin-sub">${esc([c.city, c.state].filter(Boolean).join(', '))}${c.group ? ' · ' + esc(c.group) : ''}</div>
          <div class="pin-sub">Last activity: ${esc(agoLabel(c.lastActivityAt))}</div>
          <div class="pin-actions">
            ${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^+\d]/g, ''))}">📞 Call</a>` : ''}
            <a href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}" target="_blank" rel="noopener">🧭 Go</a>
            <a href="#/company/${esc(c.id)}/log">＋ Log</a>
          </div>
        </div>`, { closeButton: false });
      cluster.addLayer(m);
    }
    map.addLayer(cluster);
    drawLegend();
  };

  const drawLegend = () => {
    const el = document.getElementById('maplegend');
    if (mapState.colorMode === 'recency') {
      el.innerHTML = `
        <span><i style="background:${RECENCY_COLORS.fresh}"></i>≤30d</span>
        <span><i style="background:${RECENCY_COLORS.warm}"></i>≤90d</span>
        <span><i style="background:${RECENCY_COLORS.cold}"></i>colder</span>`;
    } else {
      const counts = new Map();
      for (const c of companies) {
        const g = (c.group || '').split(';')[0].trim() || '(none)';
        counts.set(g, (counts.get(g) || 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      el.innerHTML = top.map(([g]) =>
        `<span><i style="background:${g === '(none)' ? '#5c6b7a' : groupColor(g)}"></i>${esc(g)}</span>`).join('');
    }
  };

  // initial viewport: saved position, else fit the whole territory
  if (mapState.center) {
    map.setView(mapState.center, mapState.zoom);
  } else if (companies.length) {
    map.fitBounds(companies.map(c => [Number(c.lat), Number(c.lng)]), { padding: [30, 30] });
  } else {
    map.setView([33.5, -83.5], 6); // Southeast fallback
  }
  map.on('moveend', () => {
    const c = map.getCenter();
    mapState.center = [c.lat, c.lng];
    mapState.zoom = map.getZoom();
  });

  drawPins();

  document.getElementById('mapmode').onclick = e => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.dataset.mode === mapState.colorMode) return;
    mapState.colorMode = btn.dataset.mode;
    for (const b of e.currentTarget.children) b.classList.toggle('active', b === btn);
    drawPins();
  };

  // --- Near Me: locate, draw the radius, list what's inside, closest first ---
  let hereLayer = null;
  document.getElementById('nearme').onclick = () => {
    const btn = document.getElementById('nearme');
    if (!navigator.geolocation) { toast('This device does not expose location', true); return; }
    btn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(pos => {
      btn.textContent = '📍 Near me';
      const { latitude: lat, longitude: lng } = pos.coords;
      if (hereLayer) map.removeLayer(hereLayer);
      hereLayer = L.layerGroup([
        L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#1668b8', fillOpacity: 1 }),
        L.circle([lat, lng], { radius: mapState.radiusMi * 1609.34, color: '#1668b8', weight: 1, fillOpacity: 0.05 }),
      ]).addTo(map);
      map.fitBounds(L.latLng(lat, lng).toBounds(mapState.radiusMi * 2 * 1609.34));

      const near = companies
        .map(c => ({ c, mi: milesBetween(lat, lng, Number(c.lat), Number(c.lng)) }))
        .filter(x => x.mi <= mapState.radiusMi)
        .sort((a, b) => a.mi - b.mi);

      const panel = document.getElementById('nearpanel');
      panel.hidden = false;
      panel.innerHTML = `
        <div class="near-head">
          <b>${near.length} within</b>
          <select id="near-radius">${[10, 25, 50, 100].map(r =>
            `<option value="${r}" ${r === mapState.radiusMi ? 'selected' : ''}>${r} mi</option>`).join('')}</select>
          <button class="btn small" id="near-close">✕</button>
        </div>
        <ul>${near.slice(0, 40).map(({ c, mi }) => `
          <li><a href="#/company/${esc(c.id)}">
            <span class="dot ${recencyClass(c.lastActivityAt)}"></span>
            <span class="near-name">${esc(c.name)}</span>
            <span class="near-mi">${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi</span>
          </a></li>`).join('') || '<li class="muted" style="padding:10px">Nothing in range.</li>'}
        </ul>`;
      document.getElementById('near-close').onclick = () => { panel.hidden = true; };
      document.getElementById('near-radius').onchange = e2 => {
        mapState.radiusMi = Number(e2.target.value);
        document.getElementById('nearme').click();
      };
    }, err => {
      btn.textContent = '📍 Near me';
      toast('Could not get your location: ' + err.message, true);
    }, { enableHighAccuracy: true, timeout: 12000 });
  };
}

// ---------------------------------------------------------------- companies list

const listState = { q: '', state: '', group: '', sort: 'name' };

async function viewCompanies() {
  const [companies, allContacts] = await Promise.all([getAll('companies'), getAll('contacts')]);

  // Searching also matches contact names: "trey white" finds Carolina Fabricators.
  const contactsByCompany = new Map();
  for (const p of allContacts) {
    const name = (p.firstName + ' ' + p.lastName).trim();
    if (!p.companyId || !name) continue;
    if (!contactsByCompany.has(p.companyId)) contactsByCompany.set(p.companyId, []);
    contactsByCompany.get(p.companyId).push(name);
  }

  const states = [...new Set(companies.map(c => c.state).filter(Boolean))].sort();
  const groups = [...new Set(companies.flatMap(c => (c.group || '').split(';').map(g => g.trim())).filter(Boolean))].sort();

  $view.innerHTML = `
  <div class="listhead">
    <input type="search" id="q" placeholder="Search company, city, group, or person…" value="${esc(listState.q)}">
    <div class="filters">
      <select id="f-state"><option value="">State</option>${states.map(s =>
        `<option ${s === listState.state ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select id="f-group"><option value="">Group</option>${groups.map(g =>
        `<option ${g === listState.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      <select id="f-sort">
        <option value="name" ${listState.sort === 'name' ? 'selected' : ''}>A–Z</option>
        <option value="city" ${listState.sort === 'city' ? 'selected' : ''}>City</option>
        <option value="recent" ${listState.sort === 'recent' ? 'selected' : ''}>Last activity</option>
      </select>
      <button class="btn small" id="add-company">+ New</button>
    </div>
  </div>
  <ul class="cardlist" id="companylist"></ul>
  <p class="muted center" id="listcount"></p>`;

  const drawList = () => {
    const q = listState.q.toLowerCase();
    const contactHit = new Map(); // companyId -> matching contact name (for the hint)
    let rows = companies.filter(c => {
      if ((listState.state && c.state !== listState.state) ||
          (listState.group && !(c.group || '').includes(listState.group))) return false;
      if (!q) return true;
      if ((c.name + ' ' + c.city + ' ' + c.group).toLowerCase().includes(q)) return true;
      const person = (contactsByCompany.get(c.id) || []).find(n => n.toLowerCase().includes(q));
      if (person) { contactHit.set(c.id, person); return true; }
      return false;
    });

    if (listState.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    if (listState.sort === 'city') rows.sort((a, b) => (a.city || '').localeCompare(b.city || '') || a.name.localeCompare(b.name));
    if (listState.sort === 'recent') rows.sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));

    const CAP = 300;
    document.getElementById('companylist').innerHTML = rows.slice(0, CAP).map(c => `
      <li><a class="card" href="#/company/${esc(c.id)}">
        <span class="dot ${recencyClass(c.lastActivityAt)}"></span>
        <span class="card-main">
          <span class="card-title">${esc(c.name)}</span>
          <span class="card-sub">${esc([c.city, c.state].filter(Boolean).join(', '))}${c.group ? ' · ' + esc(c.group) : ''}${contactHit.has(c.id) ? ' · 👤 ' + esc(contactHit.get(c.id)) : ''}</span>
        </span>
        <span class="card-side">${esc(agoLabel(c.lastActivityAt))}</span>
      </a></li>`).join('');
    document.getElementById('listcount').textContent =
      rows.length > CAP ? `Showing ${CAP} of ${rows.length} — refine your search`
        : `${rows.length} compan${rows.length === 1 ? 'y' : 'ies'}`;
  };

  drawList();
  document.getElementById('q').oninput = e => { listState.q = e.target.value; drawList(); };
  document.getElementById('f-state').onchange = e => { listState.state = e.target.value; drawList(); };
  document.getElementById('f-group').onchange = e => { listState.group = e.target.value; drawList(); };
  document.getElementById('f-sort').onchange = e => { listState.sort = e.target.value; drawList(); };
  document.getElementById('add-company').onclick = () => { location.hash = '#/company/new'; };
}

// ---------------------------------------------------------------- company detail

async function viewCompany(id) {
  const c = await getById('companies', id);
  if (!c) { $view.innerHTML = '<div class="pad"><p>Company not found (it may have been deleted).</p></div>'; return; }
  const contacts = (await getByIndex('contacts', 'companyId', id))
    .sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  const activities = (await getByIndex('activities', 'companyId', id))
    .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''));

  const addr = [c.street, [c.city, c.state].filter(Boolean).join(', '), c.zip].filter(Boolean).join(', ');
  const mapsUrl = c.lat ? `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`
    : addr ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}` : '';

  const SHOW = 30;
  $view.innerHTML = `
  <div class="pad">
    <a class="backlink" href="#/companies">‹ Companies</a>
    <div class="detail-head">
      <h1>${esc(c.name)}</h1>
      <span class="dot big ${recencyClass(c.lastActivityAt)}" title="last activity ${esc(agoLabel(c.lastActivityAt))}"></span>
    </div>
    <p class="muted">${esc([c.group, c.priority && ('Priority ' + c.priority)].filter(Boolean).join(' · '))}</p>

    <div class="actionrow">
      ${c.phone ? `<a class="btn" href="tel:${esc(c.phone.replace(/[^+\d]/g, ''))}">📞 Call</a>` : ''}
      ${mapsUrl ? `<a class="btn" href="${esc(mapsUrl)}" target="_blank" rel="noopener">🧭 Directions</a>` : ''}
      <a class="btn primary" href="#/company/${esc(id)}/log">＋ Log activity</a>
    </div>

    <div class="factbox">
      ${addr ? `<div>${esc(addr)}</div>` : '<div class="muted">No address</div>'}
      ${c.phone ? `<div>${esc(c.phone)}</div>` : ''}
      ${c.email ? `<div><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}
      ${c.website ? `<div><a href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a></div>` : ''}
      ${c.notes ? `<div class="prewrap">${esc(c.notes)}</div>` : ''}
      <a class="editlink" href="#/company/${esc(id)}/edit">Edit company</a>
    </div>

    <h2>Contacts (${contacts.length})
      <a class="btn small" href="#/company/${esc(id)}/contact/new">+ Add</a></h2>
    <ul class="cardlist">
      ${contacts.map(p => `
        <li class="card static">
          <span class="card-main">
            <span class="card-title">${esc((p.firstName + ' ' + p.lastName).trim() || '(no name)')}</span>
            <span class="card-sub">${esc(p.title || '')}</span>
            <span class="contactlinks">
              ${p.phoneMobile ? `<a href="tel:${esc(p.phoneMobile.replace(/[^+\d]/g, ''))}">📱 ${esc(p.phoneMobile)}</a>` : ''}
              ${p.phoneOffice ? `<a href="tel:${esc(p.phoneOffice.replace(/[^+\d]/g, ''))}">☎️ ${esc(p.phoneOffice)}</a>` : ''}
              ${p.email ? `<a href="mailto:${esc(p.email)}" data-logmail="${esc(p.id)}">✉️ ${esc(p.email)}</a>` : ''}
            </span>
          </span>
          <a class="card-side editlink" href="#/contact/${esc(p.id)}/edit">Edit</a>
        </li>`).join('') || '<li class="muted pad-s">No contacts yet.</li>'}
    </ul>

    <h2>Activity (${activities.length})</h2>
    <ul class="timeline" id="timeline">
      ${activities.slice(0, SHOW).map(a => timelineItem(a, contacts)).join('') || '<li class="muted">Nothing logged yet.</li>'}
    </ul>
    ${activities.length > SHOW ? `<button class="btn small center" id="morebtn">Show all ${activities.length}</button>` : ''}
  </div>`;

  const more = document.getElementById('morebtn');
  if (more) more.onclick = () => {
    document.getElementById('timeline').innerHTML = activities.map(a => timelineItem(a, contacts)).join('');
    more.remove();
  };

  // "Email → log it?" hand-off (spec §10): after opening the mail app,
  // offer one tap to record the outreach.
  for (const link of $view.querySelectorAll('[data-logmail]')) {
    link.addEventListener('click', () => {
      const contactId = link.getAttribute('data-logmail');
      setTimeout(async () => {
        if (confirm('Log this email as an activity?')) {
          await tryWrite(() => createRow('Activities', {
            companyId: id, contactId, type: 'email',
            occurredAt: new Date().toISOString(),
            subject: 'Email sent', body: '', followUpDone: 'FALSE',
          }), 'Email logged');
          render();
        }
      }, 800);
    });
  }
}

function timelineItem(a, contacts) {
  const who = contacts.find(p => p.id === a.contactId);
  return `
    <li>
      <span class="tl-icon">${TYPE_ICONS[a.type] || '📝'}</span>
      <span class="tl-main">
        <span class="tl-title">${esc(a.subject || a.type)}</span>
        ${who ? `<span class="tl-who">${esc(who.firstName + ' ' + who.lastName)}</span>` : ''}
        ${a.body ? `<span class="tl-body prewrap">${esc(a.body)}</span>` : ''}
        ${a.followUpDate && a.followUpDone !== 'TRUE' ? `<span class="tl-follow">Follow up ${esc(fmtDate(a.followUpDate))}</span>` : ''}
      </span>
      <span class="tl-date">${esc(fmtDate(a.occurredAt))}</span>
    </li>`;
}

// ---------------------------------------------------------------- company form

async function viewCompanyForm(id) {
  const c = id ? await getById('companies', id) : {};
  if (id && !c) { location.hash = '#/companies'; return; }
  const f = (name, label, type = 'text') => `
    <label>${label}<input name="${name}" type="${type}" value="${esc(c[name] || '')}"></label>`;

  $view.innerHTML = `
  <div class="pad">
    <a class="backlink" href="${id ? '#/company/' + esc(id) : '#/companies'}">‹ Back</a>
    <h1>${id ? 'Edit company' : 'New company'}</h1>
    <form id="form">
      ${f('name', 'Name *')}
      ${f('street', 'Street')} ${f('city', 'City')}
      <div class="row2">${f('state', 'State (2 letters)')} ${f('zip', 'Zip')}</div>
      ${f('phone', 'Phone', 'tel')} ${f('email', 'Email', 'email')} ${f('website', 'Website')}
      ${f('group', 'Group')} ${f('priority', 'Priority (A/B/C)')}
      <label>Notes<textarea name="notes" rows="4">${esc(c.notes || '')}</textarea></label>
      <button class="btn primary" type="submit">${id ? 'Save changes' : 'Create company'}</button>
      ${id ? '<button class="btn danger" type="button" id="delbtn">Delete company</button>' : ''}
    </form>
  </div>`;

  document.getElementById('form').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    if (!fd.name.trim()) { toast('Name is required', true); return; }
    fd.state = fd.state.trim().toUpperCase();
    fd.territoryState = ['GA', 'SC', 'NC', 'TN', 'AL', 'FL'].includes(fd.state) ? fd.state : '';

    const result = await tryWrite(async () => {
      if (id) return (await updateRow('Companies', { id, ...fd })).row;
      const created = (await createRow('Companies', { ...fd, deleted: 'FALSE' })).row;
      // new company: ask the backend to geocode it right away (spec §8)
      api('geocode', { id: created.id }).catch(() => {});
      return created;
    }, id ? 'Saved' : 'Company created');
    if (result) {
      await putRow('companies', result);
      location.hash = '#/company/' + result.id;
    }
  };

  const del = document.getElementById('delbtn');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${c.name}? (It is only hidden, never truly erased — recoverable from the Sheet.)`)) return;
    const ok = await tryWrite(() => softDelete('Companies', id), 'Company deleted');
    if (ok) { const { deleteRow } = await import('./db.js'); await deleteRow('companies', id); location.hash = '#/companies'; }
  };
}

// ---------------------------------------------------------------- contact form

async function viewContactForm(contactId, companyId) {
  const p = contactId ? await getById('contacts', contactId) : { companyId };
  if (contactId && !p) { location.hash = '#/companies'; return; }
  const backId = p.companyId || companyId;
  const f = (name, label, type = 'text') => `
    <label>${label}<input name="${name}" type="${type}" value="${esc(p[name] || '')}"></label>`;

  $view.innerHTML = `
  <div class="pad">
    <a class="backlink" href="#/company/${esc(backId)}">‹ Back</a>
    <h1>${contactId ? 'Edit contact' : 'New contact'}</h1>
    <form id="form">
      <div class="row2">${f('firstName', 'First name *')} ${f('lastName', 'Last name')}</div>
      ${f('title', 'Title')}
      ${f('email', 'Email', 'email')}
      <div class="row2">${f('phoneMobile', 'Mobile', 'tel')} ${f('phoneOffice', 'Office', 'tel')}</div>
      ${f('role', 'Role (Buyer, Engineer…)')}
      <label>Notes<textarea name="notes" rows="3">${esc(p.notes || '')}</textarea></label>
      <button class="btn primary" type="submit">${contactId ? 'Save changes' : 'Add contact'}</button>
      ${contactId ? '<button class="btn danger" type="button" id="delbtn">Delete contact</button>' : ''}
    </form>
  </div>`;

  document.getElementById('form').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    if (!fd.firstName.trim()) { toast('First name is required', true); return; }
    const result = await tryWrite(async () => {
      if (contactId) return (await updateRow('Contacts', { id: contactId, ...fd })).row;
      return (await createRow('Contacts', { ...fd, companyId: backId, deleted: 'FALSE' })).row;
    }, contactId ? 'Saved' : 'Contact added');
    if (result) { await putRow('contacts', result); location.hash = '#/company/' + backId; }
  };

  const del = document.getElementById('delbtn');
  if (del) del.onclick = async () => {
    if (!confirm('Delete this contact?')) return;
    const ok = await tryWrite(() => softDelete('Contacts', contactId), 'Contact deleted');
    if (ok) { const { deleteRow } = await import('./db.js'); await deleteRow('contacts', contactId); location.hash = '#/company/' + backId; }
  };
}

// ---------------------------------------------------------------- log activity

async function viewActivityForm(companyId) {
  const c = await getById('companies', companyId);
  if (!c) { location.hash = '#/companies'; return; }
  const contacts = (await getByIndex('contacts', 'companyId', companyId))
    .sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));

  $view.innerHTML = `
  <div class="pad">
    <a class="backlink" href="#/company/${esc(companyId)}">‹ ${esc(c.name)}</a>
    <h1>Log activity</h1>
    <form id="form">
      <div class="typerow" id="typerow">
        ${ACTIVITY_TYPES.map((t, i) => `
          <button type="button" class="typebtn${i === 0 ? ' active' : ''}" data-type="${t}">
            ${TYPE_ICONS[t]}<br>${t}</button>`).join('')}
      </div>
      <label>Contact (optional)
        <select name="contactId"><option value="">—</option>
          ${contacts.map(p => `<option value="${esc(p.id)}">${esc(p.firstName + ' ' + p.lastName)}</option>`).join('')}
        </select>
      </label>
      <label>Subject<input name="subject" placeholder="e.g. Quoted 3 castings"></label>
      <label>Notes<textarea name="body" rows="5" placeholder="What happened?"></textarea></label>
      <label>When<input name="occurredAt" type="datetime-local" value="${nowLocalInput()}"></label>
      <label>Follow up on (optional)<input name="followUpDate" type="date" min="${todayStr()}"></label>
      <button class="btn primary big" type="submit">Save activity</button>
    </form>
  </div>`;

  let type = ACTIVITY_TYPES[0];
  document.getElementById('typerow').onclick = e => {
    const btn = e.target.closest('.typebtn');
    if (!btn) return;
    type = btn.dataset.type;
    for (const b of e.currentTarget.children) b.classList.toggle('active', b === btn);
  };

  document.getElementById('form').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const occurred = fd.occurredAt ? new Date(fd.occurredAt).toISOString() : new Date().toISOString();
    const result = await tryWrite(() => createRow('Activities', {
      companyId, contactId: fd.contactId, type,
      occurredAt: occurred, subject: fd.subject, body: fd.body,
      followUpDate: fd.followUpDate || '', followUpDone: 'FALSE',
    }), 'Activity saved');
    if (result) {
      await putRow('activities', result.row);
      c.lastActivityAt = occurred > (c.lastActivityAt || '') ? occurred : c.lastActivityAt;
      await putRow('companies', c);
      location.hash = '#/company/' + companyId;
    }
  };
}

// ---------------------------------------------------------------- follow-ups

async function viewFollowups() {
  const [activities, companies] = await Promise.all([getAll('activities'), getAll('companies')]);
  const byId = new Map(companies.map(c => [c.id, c]));
  const today = todayStr();
  const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const open = activities.filter(a => a.followUpDate && a.followUpDone !== 'TRUE')
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
  const due = open.filter(a => a.followUpDate <= today);
  const upcoming = open.filter(a => a.followUpDate > today && a.followUpDate <= soon);
  const later = open.filter(a => a.followUpDate > soon);

  const item = a => {
    const co = byId.get(a.companyId);
    return `
    <li class="card static">
      <span class="card-main">
        <a class="card-title" href="#/company/${esc(a.companyId)}">${esc(co ? co.name : '(unknown company)')}</a>
        <span class="card-sub">${esc(a.subject || a.type)}</span>
      </span>
      <span class="card-side">
        <span class="${a.followUpDate <= today ? 'overdue' : 'muted'}">${esc(fmtDate(a.followUpDate))}</span>
        <button class="btn small" data-done="${esc(a.id)}">Done</button>
      </span>
    </li>`;
  };

  $view.innerHTML = `
  <div class="pad">
    <h1>Follow-ups</h1>
    <h2>Due (${due.length})</h2>
    <ul class="cardlist">${due.map(item).join('') || '<li class="muted pad-s">Nothing due. 🎉</li>'}</ul>
    <h2>Next 7 days (${upcoming.length})</h2>
    <ul class="cardlist">${upcoming.map(item).join('') || '<li class="muted pad-s">Nothing scheduled.</li>'}</ul>
    ${later.length ? `<h2>Later (${later.length})</h2><ul class="cardlist">${later.slice(0, 20).map(item).join('')}</ul>` : ''}
  </div>`;

  $view.onclick = async e => {
    const btn = e.target.closest('[data-done]');
    if (!btn) return;
    btn.disabled = true;
    const a = activities.find(x => x.id === btn.dataset.done);
    const result = await tryWrite(() => updateRow('Activities', { id: a.id, followUpDone: 'TRUE' }), 'Marked done');
    if (result) { await putRow('activities', result.row); render(); }
    else btn.disabled = false;
  };
}

// ---------------------------------------------------------------- settings

async function viewSettings() {
  const n = await counts();
  const last = await lastSyncTime();
  const meta = (await kvGet('meta')) || {};
  let persisted = false;
  if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();

  $view.innerHTML = `
  <div class="pad">
    <h1>Settings</h1>
    <div class="factbox">
      <div>Cached here: <b>${n.companies}</b> companies, <b>${n.contacts}</b> contacts, <b>${n.activities}</b> activities</div>
      <div>Last synced: <b>${last ? esc(new Date(last).toLocaleString()) : 'never'}</b></div>
      <div>Storage protected from cleanup: <b>${persisted ? 'yes' : 'not yet'}</b></div>
      ${meta.migratedAt ? `<div class="muted">Data migrated from MMC: ${esc(fmtDate(meta.migratedAt))}</div>` : ''}
      ${syncState.lastError ? `<div class="overdue">Last sync error: ${esc(syncState.lastError)}</div>` : ''}
    </div>
    <button class="btn" id="syncbtn">Sync now</button>
    <button class="btn" id="reloadbtn">Re-download everything</button>
    <button class="btn danger" id="disconnect">Disconnect this device</button>
    <p class="muted">Disconnecting removes the cached data, URL and token from
       this device only. The database in your Google Sheet is untouched.</p>
  </div>`;

  document.getElementById('syncbtn').onclick = async e => {
    e.target.textContent = 'Syncing…';
    const ok = await syncNow();
    toast(ok ? 'Synced' : 'Sync failed: ' + syncState.lastError, !ok);
    render();
  };
  document.getElementById('reloadbtn').onclick = async e => {
    e.target.textContent = 'Downloading…';
    try { await fullLoad(); toast('Fresh copy downloaded'); } catch (err) { toast(err.message, true); }
    render();
  };
  document.getElementById('disconnect').onclick = async () => {
    if (!confirm('Disconnect this device and wipe its local copy?')) return;
    await clearAll();
    clearCreds();
    location.hash = '#/setup';
  };
}

// ---------------------------------------------------------------- boot

window.addEventListener('hashchange', render);
onSyncChange(() => { $syncdot.classList.toggle('on', syncState.running); });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && hasCreds()) syncSoon();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
if (hasCreds()) syncSoon();
