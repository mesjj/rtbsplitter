'use strict';
// Splitwise frontend. Vanilla JS, no build step. All money is integer cents.

// Each group has its own currency. Amounts are never converted.
// CURRENCY / UNIT / CURRENCY_SYMBOL follow the group being viewed or edited.
const formatters = new Map();
function currencyInfo(code) {
  if (!formatters.has(code)) {
    const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
    const unit = digits === 0 ? 100 : 1; // zero-decimal currencies (JPY, KRW…) use whole amounts only
    // Up to 2 decimals shown either way, so nothing is ever silently rounded.
    // narrowSymbol: ฿ rather than "THB", € rather than "EUR".
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', minimumFractionDigits: unit === 1 ? 2 : 0, maximumFractionDigits: 2 });
    formatters.set(code, { fmt, unit, symbol: fmt.formatToParts(0).find(p => p.type === 'currency')?.value || code });
  }
  return formatters.get(code);
}
let CURRENCY, CURRENCY_SYMBOL, UNIT;
function setCurrency(code) {
  CURRENCY = code;
  ({ unit: UNIT, symbol: CURRENCY_SYMBOL } = currencyInfo(code));
}
setCurrency('USD');
const money = (c, code = CURRENCY) => currencyInfo(code).fmt.format(c / 100);
const inputValue = c => (UNIT === 1 ? (c / 100).toFixed(2) : String(c / 100)); // cents → text for an <input>
const STEP = () => (UNIT === 1 ? '0.01' : '1');

let me = null;
// App shell { users, groups } merged with the open group's state
// { group, expenses, payments, balances, settlements } when a group page is showing.
let data = null;
let activityFilter = 'all';
const expanded = new Set();

// Per-browser view preferences (show archived). Storage may be unavailable.
const prefs = (() => {
  let p = { archived: false };
  try { p = { ...p, ...JSON.parse(localStorage.getItem('sw-prefs') || '{}') }; } catch {}
  return p;
})();
function savePrefs() { try { localStorage.setItem('sw-prefs', JSON.stringify(prefs)); } catch {} }

// --- Telegram Mini App ------------------------------------------------------------
// Opened from the bot's "Open Splitwise" button, Telegram puts signed launch data in the
// URL fragment (#tgWebAppData=…). We keep it for signing in and load Telegram's script.
const TG = (() => {
  let initData = '';
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('tgWebAppData')) {
    initData = params.get('tgWebAppData');
    try { sessionStorage.setItem('sw-tg-init', initData); } catch {}
  } else {
    try { initData = sessionStorage.getItem('sw-tg-init') || ''; } catch {}
  }
  if (initData) {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.onload = () => {
      try { window.Telegram.WebApp.ready(); window.Telegram.WebApp.expand(); } catch {}
      // The SDK has read its launch data now, so tidy the address for our own routing.
      if (location.hash.includes('tgWebAppData')) history.replaceState(null, '', `${location.pathname}#/home`);
    };
    document.head.append(script);
  }
  return { initData, inTelegram: !!initData };
})();

// Inside Telegram, cookies can be blocked (its desktop and web apps show the site in a
// frame), so the session token is kept for this tab and sent as a header instead.
let bearerToken = (() => { try { return sessionStorage.getItem('sw-token'); } catch { return null; } })();
function setBearer(token) {
  bearerToken = token || null;
  try { token ? sessionStorage.setItem('sw-token', token) : sessionStorage.removeItem('sw-token'); } catch {}
}

// ---------------------------------------------------------------------------
// DOM helpers — everything user-supplied goes in as text, never HTML.

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = sel => document.querySelector(sel);

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M1.5 21a7.5 7.5 0 0 1 15 0M16 3.5a4 4 0 0 1 0 9M22.5 21a7.5 7.5 0 0 0-4.5-6.9"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
function icon(name, size = 18) {
  const span = document.createElement('span');
  span.style.lineHeight = '0';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}
// The app icon (same artwork as public/icon.svg): a coin split in two.
function logoMark() {
  return h('img', { class: 'logo-mark', src: '/icon.svg', alt: '', width: 30, height: 30 });
}

const AVATAR_COLORS = ['#1cc29f', '#ff652f', '#5b7cfa', '#e0a100', '#b45cd6', '#e5487a', '#2a9d8f', '#8a6d3b', '#3d8bd9', '#d9534f'];
function avatar(user, size = '') {
  const name = user?.name || '?';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const color = AVATAR_COLORS[(user?.id || 0) % AVATAR_COLORS.length];
  return h('span', { class: `avatar ${size}`, style: `background:${color}`, title: name, 'aria-hidden': 'true' }, initials);
}

// ---------------------------------------------------------------------------
// Utilities

const userById = id => data.users.find(u => u.id === id) || { id, name: 'Unknown' };
const nameOf = id => (id === me.id ? 'You' : userById(id).name);
const nameOfLower = id => (id === me.id ? 'you' : userById(id).name);
const groupById = id => data.groups.find(g => g.id === id);
const isCurrentMember = (g, uid = me.id) => g.members.some(m => m.userId === uid && !m.past);
// Groups you can add expenses/payments to right now.
const writableGroups = () => data.groups.filter(g => !g.archived && (me.isAdmin || isCurrentMember(g)));
const canWrite = g => !!g && !g.archived && (me.isAdmin || isCurrentMember(g));
// Active, current members of a group — who can be picked for new expenses.
const pickableMembers = g => data.users.filter(u => u.active && isCurrentMember(g, u.id));

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const centsFrom = v => {
  const n = Number(String(v).trim());
  return v === '' || !Number.isFinite(n) ? NaN : Math.round(n * 100);
};

// Same largest-remainder split the server uses — for live previews only.
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const parts = weights.map(w => Math.floor((total * w) / sum));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => ({ i, r: (total * w) % sum })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i]++;
  return parts;
}
// Split an amount in cents into whole units of the current currency.
const allocateMoney = (total, weights) => allocate(Math.round(total / UNIT), weights).map(p => p * UNIT);

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    me = null;
    setBearer(null);
    closeModal();
    renderLogin();
    throw new Error(json.error || 'Please log in.');
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

async function refresh() {
  const shell = await api('GET', '/api/state');
  const fresh = shell.users.find(u => u.id === me.id);
  if (fresh) Object.assign(me, { name: fresh.name, isAdmin: fresh.isAdmin });
  const r = parseRoute();
  let groupState = { group: null };
  if (r.groupId && shell.groups.some(g => g.id === r.groupId)) {
    groupState = await api('GET', `/api/groups/${r.groupId}/state`);
    setCurrency(groupState.group.currency);
  }
  data = { ...shell, ...groupState };
  render();
}

// ---------------------------------------------------------------------------
// Login

function renderLogin() {
  const err = h('p', { class: 'error-msg hidden' });
  const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Log in');

  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      err.classList.add('hidden');
      try {
        const r = await api('POST', '/api/login', { username: user.value, password: pass.value, wantToken: TG.inTelegram });
        if (r.token) setBearer(r.token);
        await boot();
        if (TG.inTelegram) {
          // Connect this Telegram account: notifications + automatic sign-in next time.
          api('POST', '/api/me/telegram/webapp-link', { initData: TG.initData })
            .then(() => toast('Telegram connected — you’ll be signed in automatically next time'))
            .catch(() => {});
        }
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        btn.disabled = false;
        pass.select();
      }
    },
  },
    h('label', { class: 'field' }, h('span', {}, 'Username'), user),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pass),
    err, btn);

  $('#app').replaceChildren(
    h('div', { class: 'login-wrap' },
      h('div', { class: 'login-card' },
        h('div', { class: 'logo' }, logoMark(), 'Splitwise'),
        h('p', { class: 'muted' }, 'Split bills with your people.'),
        TG.inTelegram && h('p', { class: 'small tg-hint' }, 'Log in once here and this Telegram account will be connected — after that the app opens already signed in.'),
        form)));
  user.focus();
}

// ---------------------------------------------------------------------------
// Shell

// Routes: #/home · #/groups/:id · #/groups/:id/expenses · #/admin
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'groups' && /^\d+$/.test(parts[1] || '')) {
    return { page: parts[2] === 'expenses' ? 'expenses' : 'overview', groupId: Number(parts[1]) };
  }
  if (parts[0] === 'admin') return { page: 'admin' };
  return { page: 'home' };
}

// Groups shown in lists, after the archived toggle.
function visibleGroups() {
  return data.groups.filter(g => prefs.archived || !g.archived);
}

function render() {
  if (!me || !data) return;
  let r = parseRoute();
  if (r.page === 'admin' && !me.isAdmin) r = { page: 'home' };
  if (r.groupId && !data.group) r = { page: 'home' }; // unknown or hidden group

  if (data.group) setCurrency(data.group.currency);
  const main = h('main', {});
  if (r.page === 'home') renderHome(main);
  else if (r.page === 'overview') { main.append(groupHead('overview')); renderDashboard(main); }
  else if (r.page === 'expenses') { main.append(groupHead('expenses')); renderActivity(main); }
  else renderAdmin(main);

  $('#app').replaceChildren(topbar(), h('div', { class: 'layout' }, sidenav(r), main));
}

function sidenav(r) {
  const archivedToggle = h('label', { class: 'check small muted nav-archived' },
    h('input', { type: 'checkbox', checked: prefs.archived, onchange: e => { prefs.archived = e.target.checked; savePrefs(); render(); } }),
    'Show archived');

  const list = visibleGroups();
  return h('nav', { class: 'sidenav' },
    h('a', { href: '#/home', class: r.page === 'home' ? 'active' : '' }, icon('home'), 'Home'),
    h('div', { class: 'nav-groups' },
      h('div', { class: 'nav-label' }, h('span', {}, 'Groups'),
        h('button', { class: 'icon-btn', title: 'New group', 'aria-label': 'New group', onclick: () => openGroupModal() }, icon('plus', 16))),
      list.map(g => h('a', { href: `#/groups/${g.id}`, class: `nav-group ${r.groupId === g.id ? 'active' : ''} ${g.archived ? 'archived' : ''}` },
        h('span', { class: 'nav-group-name' }, g.name),
        h('span', { class: `dot ${g.myBalance > 0 ? 'pos' : g.myBalance < 0 ? 'neg' : ''}` }))),
      !list.length && h('div', { class: 'small muted nav-empty' }, data.groups.length ? 'No groups match.' : 'No groups yet.'),
      data.groups.some(g => g.archived) && archivedToggle),
    me.isAdmin && h('div', { class: 'sep' }),
    me.isAdmin && h('a', { href: '#/admin', class: r.page === 'admin' ? 'active' : '' }, icon('users'), 'Admin'));
}

function topbar() {
  const menu = h('div', { class: 'menu hidden' },
    h('div', { class: 'menu-head' }, h('strong', {}, me.name), h('div', { class: 'small muted' }, `@${me.username}`)),
    h('button', { onclick: () => { menu.classList.add('hidden'); openNameModal(); } }, 'Change display name'),
    h('button', { onclick: () => { menu.classList.add('hidden'); openTelegramModal(); } }, 'Telegram notifications'),
    h('button', { onclick: () => { menu.classList.add('hidden'); openPasswordModal(); } }, 'Change password'),
    h('button', { onclick: logout }, 'Log out'));
  const btn = h('button', {
    class: 'user-btn', 'aria-haspopup': 'true',
    onclick: e => { e.stopPropagation(); menu.classList.toggle('hidden'); },
  }, avatar(me, 'sm'), h('span', { class: 'user-name' }, me.name), icon('chevron', 14));

  return h('header', { class: 'topbar' },
    h('a', { href: '#/home', class: 'logo', style: 'text-decoration:none' }, logoMark(), 'Splitwise'),
    h('div', { class: 'spacer' }),
    h('div', { class: 'user-menu' }, btn, menu));
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  setBearer(null);
  me = null;
  data = null;
  renderLogin();
}

function groupHead(tab) {
  const g = data.group;
  const writable = canWrite(g);
  const members = g.members.filter(m => !m.past).map(m => userById(m.userId));
  return h('div', {},
    h('div', { class: 'page-head group-head' },
      h('div', { class: 'group-title' },
        h('span', { class: 'group-icon' }, icon('folder', 22)),
        h('div', { style: 'min-width:0' },
          h('h1', {}, g.name),
          h('div', { class: 'small muted group-meta' },
            h('span', { class: 'badge' }, g.currency), ' ',
            g.archived && h('span', { class: 'badge off' }, 'Archived'), ' ',
            `${members.length} ${members.length === 1 ? 'member' : 'members'}`,
            g.description && ` · ${g.description}`))),
      h('div', { class: 'actions' },
        writable && h('button', { class: 'btn accent', onclick: () => openExpenseModal(null, { groupId: g.id }) }, icon('plus', 16), 'Add expense'),
        writable && h('button', { class: 'btn primary', onclick: () => openPaymentModal({ groupId: g.id }) }, 'Settle up'),
        (me.isAdmin || isCurrentMember(g)) && h('button', { class: 'btn', title: 'Group settings', 'aria-label': 'Group settings', onclick: () => openGroupModal(g) }, icon('gear', 16)))),
    h('div', { class: 'member-strip' }, members.map(u => avatar(u, 'sm'))),
    g.archived && h('div', { class: 'banner' }, 'This group is archived and read-only. Unarchive it in group settings to make changes.'),
    h('div', { class: 'tabs' },
      h('a', { href: `#/groups/${g.id}`, class: tab === 'overview' ? 'active' : '' }, 'Overview'),
      h('a', { href: `#/groups/${g.id}/expenses`, class: tab === 'expenses' ? 'active' : '' }, 'Expenses')));
}

// ---------------------------------------------------------------------------
// Home: every group you're in, with your balance in each

function renderHome(main) {
  const groups = visibleGroups();
  const totals = new Map(); // currency → your net across groups
  for (const g of data.groups.filter(x => !x.archived)) totals.set(g.currency, (totals.get(g.currency) || 0) + g.myBalance);

  main.append(h('div', { class: 'page-head' },
    h('h1', {}, `Hi, ${me.name.split(' ')[0]}`),
    h('div', { class: 'actions' },
      writableGroups().length > 0 && h('button', { class: 'btn accent', onclick: () => openExpenseModal() }, icon('plus', 16), 'Add expense'),
      h('button', { class: 'btn primary', onclick: () => openGroupModal() }, icon('plus', 16), 'New group'))));

  if (totals.size) {
    main.append(h('div', { class: 'card stats', style: `grid-template-columns:repeat(${Math.min(totals.size, 3)}, 1fr)` },
      [...totals].map(([code, cents]) => h('div', { class: 'stat' },
        h('div', { class: 'label' }, totals.size > 1 ? `Your balance in ${code}` : 'Your balance, all groups'),
        h('div', { class: `value num ${cents > 0 ? 'owed' : cents < 0 ? 'owe' : ''}` }, money(cents, code)),
        h('div', { class: 'small muted' }, cents > 0 ? 'you are owed overall' : cents < 0 ? 'you owe overall' : 'all settled up')))));
  }

  const card = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Your groups')));
  if (!groups.length) {
    card.append(h('div', { class: 'empty' },
      data.groups.length ? 'All your groups are archived. ' : 'You’re not in any groups yet. ',
      data.groups.length > 0 && h('button', { class: 'linkish', onclick: () => { prefs.archived = true; savePrefs(); render(); } }, 'Show archived'),
      !data.groups.length && h('button', { class: 'linkish', onclick: () => openGroupModal() }, 'Create one')));
  }
  for (const g of groups) {
    const b = g.myBalance;
    card.append(h('a', { class: 'group-row', href: `#/groups/${g.id}` },
      h('span', { class: 'group-icon' }, icon('folder', 20)),
      h('div', { class: 'who' },
        h('strong', {}, g.name),
        h('span', { class: 'small muted' }, `${g.members.filter(m => !m.past).length} members · ${g.currency}`,
          g.archived ? ' · archived' : '')),
      h('div', { class: 'member-strip compact' }, g.members.filter(m => !m.past).slice(0, 5).map(m => avatar(userById(m.userId), 'sm'))),
      h('div', { class: 'item-col' },
        h('div', { class: 'l' }, b > 0 ? 'you are owed' : b < 0 ? 'you owe' : isCurrentMember(g) ? 'settled up' : 'not involved'),
        b !== 0 && h('div', { class: `v num ${b > 0 ? 'owed' : 'owe'}` }, money(Math.abs(b), g.currency)))));
  }
  main.append(card);
}

// ---------------------------------------------------------------------------
// Dashboard

function renderDashboard(main) {
  const bal = data.balances[me.id] || 0;
  const iOwe = data.settlements.filter(s => s.from === me.id);
  const owedToMe = data.settlements.filter(s => s.to === me.id);
  const sum = list => list.reduce((a, s) => a + s.amount, 0);

  const stat = (label, cents, cls) =>
    h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: `value num ${cls}` }, money(cents)));

  const personList = (list, otherKey, emptyText, verb, cls) => {
    if (!list.length) return h('div', { class: 'empty' }, emptyText);
    return list.map(s => {
      const other = userById(s[otherKey]);
      const from = otherKey === 'to' ? me.id : other.id;
      const to = otherKey === 'to' ? other.id : me.id;
      return h('div', { class: 'person-row' },
        avatar(other),
        h('div', { class: 'who' }, h('strong', {}, other.name),
          h('span', { class: `small ${cls}` }, `${verb} `, h('b', { class: 'num' }, money(s.amount)))),
        canWrite(data.group) && h('button', { class: 'btn sm', onclick: () => openPaymentModal({ groupId: data.group.id, from, to, amount: s.amount }) },
          otherKey === 'to' ? 'Settle up' : 'Record payment'));
    });
  };

  main.append(
    h('div', { class: 'card stats' },
      stat('Total balance', bal, bal > 0 ? 'owed' : bal < 0 ? 'owe' : ''),
      stat('You owe', sum(iOwe), sum(iOwe) ? 'owe' : ''),
      stat('You are owed', sum(owedToMe), sum(owedToMe) ? 'owed' : '')),
    h('div', { class: 'two-col' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'You owe')),
        personList(iOwe, 'to', 'You don’t owe anyone. Nice.', 'you owe', 'owe')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'You are owed')),
        personList(owedToMe, 'from', 'Nobody owes you anything.', 'owes you', 'owed'))),
    h('div', { style: 'height:20px' }),
    groupBalancesCard(),
    settlementsCard());
}

function groupBalancesCard() {
  // Current members, plus anyone else (past members) who still has a balance here.
  const rows = data.users
    .filter(u => u.id in data.balances)
    .map(u => ({ u, bal: data.balances[u.id] || 0 }))
    .filter(r => isCurrentMember(data.group, r.u.id) || r.bal !== 0)
    .sort((a, b) => b.bal - a.bal);
  const max = Math.max(1, ...rows.map(r => Math.abs(r.bal)));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Group balances')),
    rows.length ? rows.map(({ u, bal }) => {
      const pct = (Math.abs(bal) / max) * 50;
      return h('div', { class: 'bar-row' },
        h('div', { class: 'name' }, avatar(u, 'sm'), h('span', {}, u.id === me.id ? `${u.name} (you)` : u.name)),
        h('div', { class: 'bar-track' }, bal !== 0 && h('div', { class: `bar ${bal > 0 ? 'pos' : 'neg'}`, style: `width:${pct}%` })),
        h('div', { class: `amt num small ${bal > 0 ? 'owed' : bal < 0 ? 'owe' : 'muted'}` },
          bal === 0 ? 'settled up' : `${bal > 0 ? 'gets back' : 'owes'} ${money(Math.abs(bal))}`));
    }) : h('div', { class: 'empty' }, 'No one here yet.'));
}

function settlementsCard() {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, 'Suggested payments'),
      h('span', { class: 'small muted' }, 'fewest transfers to settle everyone')),
    data.settlements.length ? data.settlements.map(s => {
      const canRecord = canWrite(data.group) && (me.isAdmin || s.from === me.id || s.to === me.id);
      return h('div', { class: 'transfer' },
        avatar(userById(s.from), 'sm'),
        h('span', { class: 'arrow' }, icon('arrow', 16)),
        avatar(userById(s.to), 'sm'),
        h('span', { class: 'desc' }, h('b', {}, nameOf(s.from)), ` ${s.from === me.id ? 'pay' : 'pays'} `, h('b', {}, nameOfLower(s.to))),
        h('span', { class: 'amt num' }, money(s.amount)),
        canRecord && h('button', { class: 'btn sm', onclick: () => openPaymentModal({ groupId: data.group.id, from: s.from, to: s.to, amount: s.amount }) }, 'Record'));
    }) : h('div', { class: 'empty' }, 'Everyone is settled up. 🎉'));
}

// ---------------------------------------------------------------------------
// Activity (expenses + payments)

function renderActivity(main) {
  const involves = item => item.kind === 'expense'
    ? item.paidBy === me.id || item.shares.some(s => s.userId === me.id)
    : item.fromUser === me.id || item.toUser === me.id;

  let items = [
    ...data.expenses.map(e => ({ ...e, kind: 'expense' })),
    ...data.payments.map(p => ({ ...p, kind: 'payment' })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if (activityFilter === 'mine') items = items.filter(involves);

  const totalSpent = data.expenses.reduce((a, e) => a + e.amount, 0);
  const filters = h('div', { class: 'filters' },
    [['all', 'Everything'], ['mine', 'Involving me']].map(([key, label]) =>
      h('button', { class: `chip ${activityFilter === key ? 'active' : ''}`, onclick: () => { activityFilter = key; render(); } }, label)));

  const card = h('section', { class: 'card' });
  if (!items.length) {
    card.append(h('div', { class: 'empty' }, 'No expenses yet. Add one to get started.'));
  } else {
    let month = '';
    for (const item of items) {
      const d = parseISO(item.date);
      const m = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      if (m !== month) { month = m; card.append(h('div', { class: 'month' }, m)); }
      card.append(item.kind === 'expense' ? expenseItem(item, d) : paymentItem(item, d));
    }
  }

  main.append(
    h('div', { class: 'page-head', style: 'margin-top:-8px' },
      filters, h('div', { style: 'flex:1' }),
      h('span', { class: 'small muted' }, `${data.expenses.length} ${data.expenses.length === 1 ? 'expense' : 'expenses'} · ${money(totalSpent)} total`)),
    card);
}

function dateBadge(d) {
  return h('div', { class: 'date-badge' },
    h('div', { class: 'm' }, d.toLocaleDateString(undefined, { month: 'short' })),
    h('div', { class: 'd' }, d.getDate()));
}

const SPLIT_LABEL = { equal: 'split equally', exact: 'split by exact amounts', percent: 'split by percentage', shares: 'split by shares' };

function expenseItem(e, d) {
  const key = `e${e.id}`;
  const open = expanded.has(key);
  const myShare = e.shares.find(s => s.userId === me.id)?.cents || 0;
  const paidByMe = e.paidBy === me.id;
  const net = (paidByMe ? e.amount : 0) - myShare;

  let yourCol;
  if (net > 0) yourCol = h('div', { class: 'item-col' }, h('div', { class: 'l' }, 'you lent'), h('div', { class: 'v num owed' }, money(net)));
  else if (net < 0) yourCol = h('div', { class: 'item-col' }, h('div', { class: 'l' }, 'you borrowed'), h('div', { class: 'v num owe' }, money(-net)));
  else yourCol = h('div', { class: 'item-col' },
    h('div', { class: 'l' }, paidByMe || myShare ? 'no balance change' : 'not involved'), h('div', { class: 'v muted' }, '—'));

  const row = h('div', { class: 'item' },
    h('button', { class: 'item-main', 'aria-expanded': String(open), onclick: () => { open ? expanded.delete(key) : expanded.add(key); render(); } },
      dateBadge(d),
      h('span', { class: 'item-icon' }, icon('receipt', 20)),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'item-title' }, e.description),
        h('div', { class: 'item-sub' }, `${SPLIT_LABEL[e.splitType]} · ${e.shares.length} ${e.shares.length === 1 ? 'person' : 'people'}`)),
      h('div', { class: 'item-col paid' }, h('div', { class: 'l' }, `${nameOfLower(e.paidBy)} paid`), h('div', { class: 'v num' }, money(e.amount))),
      yourCol));

  if (open) {
    const canEdit = !data.group.archived && (me.isAdmin || paidByMe || e.createdBy === me.id || e.shares.some(s => s.userId === me.id));
    const valueNote = s => {
      if (e.splitType === 'percent') return ` (${s.value}%)`;
      if (e.splitType === 'shares') return ` (${s.value} ${s.value === 1 ? 'share' : 'shares'})`;
      return '';
    };
    row.append(h('div', { class: 'item-detail' },
      h('p', { class: 'small muted', style: 'margin:0 0 12px' },
        `Added by ${nameOfLower(e.createdBy)} · ${parseISO(e.date).toLocaleDateString(undefined, { dateStyle: 'medium' })}`,
        e.updatedAt ? ' · edited' : ''),
      h('ul', { class: 'split-list' },
        h('li', {}, avatar(userById(e.paidBy), 'sm'),
          h('span', { class: 'grow' }, h('b', {}, nameOf(e.paidBy)), ` paid `, h('b', { class: 'num' }, money(e.amount)))),
        e.shares.map(s => h('li', {}, avatar(userById(s.userId), 'sm'),
          h('span', { class: 'grow' }, `${nameOf(s.userId)} ${s.userId === me.id ? 'owe' : 'owes'} `,
            h('b', { class: 'num' }, money(s.cents)), h('span', { class: 'muted small' }, valueNote(s)))))),
      e.notes && h('p', { class: 'notes small' }, e.notes),
      canEdit && h('div', { class: 'detail-actions' },
        h('button', { class: 'btn sm', onclick: () => openExpenseModal(e) }, 'Edit'),
        h('button', { class: 'btn sm danger', onclick: () => deleteExpense(e) }, 'Delete'))));
  }
  return row;
}

function paymentItem(p, d) {
  const key = `p${p.id}`;
  const open = expanded.has(key);
  const mine = p.fromUser === me.id ? 'you paid' : p.toUser === me.id ? 'you received' : null;
  const row = h('div', { class: 'item' },
    h('button', { class: 'item-main', onclick: () => { open ? expanded.delete(key) : expanded.add(key); render(); } },
      dateBadge(d),
      h('span', { class: 'item-icon payment' }, icon('cash', 20)),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'item-title' }, `${nameOf(p.fromUser)} paid ${nameOfLower(p.toUser)}`),
        h('div', { class: 'item-sub' }, 'payment')),
      h('div', { class: 'item-col paid' }),
      h('div', { class: 'item-col' },
        h('div', { class: 'l' }, mine || 'amount'),
        h('div', { class: 'v num' }, money(p.amount)))));
  if (open) {
    const canDelete = !data.group.archived && (me.isAdmin || [p.fromUser, p.toUser, p.createdBy].includes(me.id));
    row.append(h('div', { class: 'item-detail' },
      h('p', { class: 'small muted', style: 'margin:0 0 12px' }, `Recorded by ${nameOfLower(p.createdBy)}`),
      p.notes && h('p', { class: 'notes small' }, p.notes),
      canDelete && h('div', { class: 'detail-actions' },
        h('button', { class: 'btn sm danger', onclick: () => deletePayment(p) }, 'Delete payment'))));
  }
  return row;
}

async function deleteExpense(e) {
  if (!(await ask({ title: 'Delete this expense?', message: `“${e.description}” (${money(e.amount)}) will be removed and everyone’s balances updated.`, confirmLabel: 'Delete', danger: true }))) return;
  try {
    await api('DELETE', `/api/expenses/${e.id}`);
    toast('Expense deleted');
    await refresh();
  } catch (ex) { toast(ex.message, true); }
}

async function deletePayment(p) {
  if (!(await ask({ title: 'Delete this payment?', message: `The ${money(p.amount)} payment will be removed and balances updated.`, confirmLabel: 'Delete', danger: true }))) return;
  try {
    await api('DELETE', `/api/payments/${p.id}`);
    toast('Payment deleted');
    await refresh();
  } catch (ex) { toast(ex.message, true); }
}

// ---------------------------------------------------------------------------
// Modals

function closeModal() { $('#modal-root').replaceChildren(); }

function openModal(title, body, footButtons, onSubmit) {
  const err = h('p', { class: 'error-msg hidden' });
  const form = h('form', {
    class: 'modal', role: 'dialog', 'aria-modal': 'true',
    onsubmit: async e => {
      e.preventDefault();
      err.classList.add('hidden');
      const submit = form.querySelector('[type=submit]');
      if (submit) submit.disabled = true;
      try {
        await onSubmit();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        if (submit) submit.disabled = false;
      }
    },
  },
    h('div', { class: 'modal-head' }, h('h2', {}, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
    h('div', { class: 'modal-body' }, body, err),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', onclick: closeModal }, 'Cancel'), footButtons));

  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: e => { if (e.target === backdrop) closeModal(); } }, form);
  $('#modal-root').replaceChildren(backdrop);
  const first = form.querySelector('.modal-body input:not([type=checkbox]), .modal-body select');
  if (first) first.focus();
  return form;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const dialog = document.querySelector('.dialog-layer');
  if (dialog) dialog.cancel(); else closeModal();
});

// Confirm / type-to-confirm dialog. Browser confirm() and prompt() are unreliable inside
// Telegram, so the app uses this everywhere. Resolves true/false, or the typed text/null.
function ask({ title, message, confirmLabel = 'OK', danger = false, input = null }) {
  return new Promise(resolve => {
    const field = input ? h('input', { class: 'input', placeholder: input.placeholder || '', autocomplete: 'off' }) : null;
    const done = value => { layer.remove(); resolve(value); };
    const layer = h('div', { class: 'modal-backdrop dialog-layer', onmousedown: e => { if (e.target === layer) layer.cancel(); } },
      h('form', { class: 'modal dialog', role: 'alertdialog', 'aria-modal': 'true', onsubmit: e => { e.preventDefault(); done(input ? field.value : true); } },
        h('div', { class: 'modal-body' }, h('h2', { class: 'dialog-title' }, title), h('p', { class: 'dialog-msg' }, message), field),
        h('div', { class: 'modal-foot' },
          h('button', { type: 'button', class: 'btn', onclick: () => layer.cancel() }, 'Cancel'),
          h('button', { type: 'submit', class: `btn ${danger ? 'danger-solid' : 'primary'}` }, confirmLabel))));
    layer.cancel = () => done(input ? null : false);
    document.body.append(layer);
    (field || layer.querySelector('[type=submit]')).focus();
  });
}
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach(m => m.classList.add('hidden')));

const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
// The input's left padding grows with the symbol ("$" vs "THB"), via --prefix-len.
const prefixAttrs = () => ({ class: 'amount-input', 'data-prefix': CURRENCY_SYMBOL, style: `--prefix-len:${[...CURRENCY_SYMBOL].length}` });
const moneyInput = attrs => h('div', prefixAttrs(),
  h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: STEP(), min: '0', placeholder: UNIT === 1 ? '0.00' : '0', ...attrs }));
const userSelect = (users, selected) => h('select', { class: 'input' },
  users.map(u => h('option', { value: u.id, selected: u.id === selected }, u.id === me.id ? `${u.name} (you)` : u.name)));

// --- add / edit expense ----------------------------------------------------

// Pick the group a new expense or payment goes into: the one asked for, else the
// open group, else your first group you can add to.
function chooseGroup(groupId) {
  const g = groupById(groupId) || (canWrite(data.group) ? groupById(data.group.id) : null) || writableGroups()[0];
  if (!g) {
    toast('Create a group first', true);
    openGroupModal();
  }
  return g;
}

// A group picker for new expenses/payments; switching reopens the form for that group.
function groupPicker(group, onSwitch) {
  const options = writableGroups();
  if (options.length < 2) return null;
  const sel = h('select', { class: 'input', onchange: () => onSwitch(Number(sel.value)) },
    options.map(g => h('option', { value: g.id, selected: g.id === group.id }, g.name)));
  return field('Group', sel);
}

// opts: { groupId, draft } — draft carries typed values across a group switch.
function openExpenseModal(existing, opts = {}) {
  const group = existing ? groupById(existing.groupId) : chooseGroup(opts.groupId);
  if (!group) return;
  setCurrency(group.currency);
  const draft = opts.draft || {};
  // People you can pick: active current members, plus anyone already on this expense.
  const involvedIds = existing ? new Set([existing.paidBy, ...existing.shares.map(s => s.userId)]) : new Set();
  const people = data.users.filter(u => pickableMembers(group).includes(u) || involvedIds.has(u.id));
  const S = {
    type: existing?.splitType || 'equal',
    rows: new Map(people.map(u => {
      const s = existing?.shares.find(x => x.userId === u.id);
      return [u.id, {
        on: existing ? !!s : true,
        value: s ? (existing.splitType === 'exact' ? inputValue(s.cents) : String(s.value ?? '')) : '',
      }];
    })),
  };

  const desc = h('input', { class: 'input', maxlength: 100, required: true, placeholder: 'e.g. Groceries', value: existing?.description || draft.description || '' });
  const amountWrap = moneyInput({ required: true, value: existing ? inputValue(existing.amount) : draft.amount || '' });
  amountWrap.classList.add('big-amount');
  const amount = amountWrap.querySelector('input');
  const paidBy = userSelect(people.filter(u => u.active || u.id === existing?.paidBy), existing?.paidBy ?? me.id);
  const date = h('input', { class: 'input', type: 'date', required: true, value: existing?.date || draft.date || todayISO() });
  const notes = h('textarea', { class: 'input', maxlength: 500, placeholder: 'Optional' }, existing?.notes || draft.notes || '');

  const seg = h('div', { class: 'segmented', role: 'tablist' });
  const rowsBox = h('div', { class: 'split-rows' });
  const tools = h('div', { class: 'split-tools' });

  const TYPES = [['equal', 'Equally'], ['exact', 'Amounts'], ['percent', 'Percent'], ['shares', 'Shares']];
  function drawSeg() {
    seg.replaceChildren(...TYPES.map(([key, label]) => h('button', {
      type: 'button', class: S.type === key ? 'active' : '', role: 'tab', 'aria-selected': String(S.type === key),
      onclick: () => { switchType(key); },
    }, label)));
  }

  function switchType(type) {
    // Seed sensible starting values when switching methods.
    const on = [...S.rows.entries()].filter(([, r]) => (S.type === 'equal' ? r.on : r.on || Number(r.value) > 0));
    for (const r of S.rows.values()) { r.on = false; r.value = ''; }
    const evenPct = allocate(10000, on.map(() => 1));
    const total = centsFrom(amount.value);
    const eq = Number.isFinite(total) && total > 0 ? allocateMoney(total, on.map(() => 1)) : null;
    on.forEach(([id], i) => {
      const r = S.rows.get(id);
      r.on = true;
      if (type === 'percent') r.value = String(evenPct[i] / 100);
      else if (type === 'shares') r.value = '1';
      else if (type === 'exact') r.value = eq ? inputValue(eq[i]) : '';
    });
    S.type = type;
    drawSeg();
    drawRows();
  }

  const shareEls = new Map();
  const inputEls = new Map(); // userId → { input, row } for amount/percent/shares rows
  let rowOrder = [];          // userIds in the order shown
  const foot = h('div', { class: 'split-foot' });

  function drawRows() {
    shareEls.clear();
    inputEls.clear();
    const list = people.filter(u => u.active || involvedIds.has(u.id));
    rowOrder = list.map(u => u.id);
    rowsBox.replaceChildren(...list.map(u => {
      const r = S.rows.get(u.id);
      const share = h('div', { class: 'share num' });
      shareEls.set(u.id, share);
      let control;
      if (S.type === 'equal') {
        control = h('label', { class: 'check', style: 'justify-self:end' },
          h('input', { type: 'checkbox', checked: r.on, onchange: e => { r.on = e.target.checked; row.classList.toggle('off', !r.on); update(); } }),
          h('span', { class: 'small muted' }, 'include'));
      } else {
        const attrs = { class: 'input num', type: 'number', inputmode: 'decimal', min: '0', step: S.type === 'shares' ? '0.5' : S.type === 'percent' ? '0.01' : STEP(), placeholder: '0', value: r.value,
          oninput: e => { r.value = e.target.value; r.on = Number(e.target.value) > 0; row.classList.toggle('off', !r.on); update(); } };
        control = S.type === 'exact'
          ? h('div', prefixAttrs(), h('input', attrs))
          : h('div', { class: 'amount-input suffix', 'data-suffix': S.type === 'percent' ? '%' : '×' }, h('input', attrs));
      }
      const row = h('div', { class: `split-row ${r.on ? '' : 'off'}` },
        h('div', { class: 'who' }, avatar(u, 'sm'), h('span', {}, u.id === me.id ? `${u.name} (you)` : u.name)),
        control, share);
      if (S.type !== 'equal') inputEls.set(u.id, { input: control.querySelector('input'), row });
      return row;
    }), foot);

    tools.replaceChildren(S.type === 'equal'
      ? h('button', { type: 'button', class: 'linkish small', onclick: () => {
          const all = [...S.rows.values()].every(r => r.on);
          for (const r of S.rows.values()) r.on = !all;
          drawRows();
        } }, 'Select all / none')
      : h('button', { type: 'button', class: 'linkish small', onclick: () => switchType(S.type) }, 'Reset to even split'));
    update();
  }

  // Recompute the live preview. Returns { ok, message }.
  function preview() {
    const total = centsFrom(amount.value);
    const entries = [...S.rows.entries()].filter(([, r]) => r.on);
    for (const el of shareEls.values()) el.textContent = '';
    if (!entries.length) return { ok: false, message: 'Pick at least one person.' };
    const haveTotal = Number.isFinite(total) && total > 0;

    if (S.type === 'equal') {
      if (haveTotal) allocateMoney(total, entries.map(() => 1)).forEach((c, i) => { shareEls.get(entries[i][0]).textContent = money(c); });
      return { ok: haveTotal, message: haveTotal ? `${money(Math.floor(total / entries.length / UNIT) * UNIT)} each · ${entries.length} ${entries.length === 1 ? 'person' : 'people'}` : 'Enter an amount.' };
    }
    const scaled = entries.map(([, r]) => (String(r.value).trim() === '' ? 0 : centsFrom(r.value))); // blank = 0, as on the server
    if (scaled.some(v => !Number.isFinite(v) || v < 0)) return { ok: false, message: 'Every value must be a number.' };
    const sum = scaled.reduce((a, b) => a + b, 0);

    if (S.type === 'exact') {
      entries.forEach(([id], i) => { shareEls.get(id).textContent = haveTotal && total ? `${Math.round((scaled[i] / total) * 1000) / 10}%` : ''; });
      if (!haveTotal) return { ok: false, message: `${money(sum)} assigned` };
      const left = total - sum;
      return left === 0 ? { ok: true, message: `${money(sum)} of ${money(total)} ✓` }
        : { ok: false, left, message: left > 0 ? `${money(left)} left to assign` : `${money(-left)} over the total` };
    }
    if (haveTotal && sum > 0 && (S.type === 'shares' || sum === 10000)) {
      allocateMoney(total, scaled).forEach((c, i) => { shareEls.get(entries[i][0]).textContent = money(c); });
    }
    if (S.type === 'percent') {
      const left = 10000 - sum;
      return left === 0 ? { ok: haveTotal, message: haveTotal ? '100% assigned ✓' : 'Enter an amount.' }
        : { ok: false, left, message: left > 0 ? `${(left / 100).toFixed(2)}% left to assign` : `${(-left / 100).toFixed(2)}% over 100%` };
    }
    if (sum <= 0) return { ok: false, message: 'Give at least one person a share.' };
    return { ok: haveTotal, message: haveTotal ? `${sum / 100} total shares` : 'Enter an amount.' };
  }
  // "Give the rest to …": puts whatever is left on the last person whose box is still
  // empty (usually the one you'd type next), or on the last person if all are filled.
  function fillRemainder(left) {
    const blank = id => !(Number(S.rows.get(id).value) > 0);
    const target = [...rowOrder].reverse().find(blank) ?? rowOrder.at(-1);
    const r = S.rows.get(target);
    const current = Number(r.value) > 0 ? centsFrom(r.value) : 0;
    const next = current + left; // cents for amounts, hundredths of a percent for percentages
    r.value = S.type === 'exact' ? inputValue(next) : String(next / 100);
    r.on = true;
    const el = inputEls.get(target);
    if (el) { el.input.value = r.value; el.row.classList.remove('off'); }
    update();
  }

  function update() {
    const p = preview();
    foot.replaceChildren(h('span', {}, SPLIT_LABEL[S.type]), h('span', {}, p.message));
    foot.className = `split-foot ${p.ok ? 'ok' : 'bad'}`;
    if ((S.type === 'exact' || S.type === 'percent') && p.left > 0 && rowOrder.length) {
      const blank = id => !(Number(S.rows.get(id).value) > 0);
      const target = [...rowOrder].reverse().find(blank) ?? rowOrder.at(-1);
      const who = target === me.id ? 'you' : userById(target).name;
      const what = S.type === 'exact' ? money(p.left) : `${(p.left / 100).toFixed(2).replace(/\.00$/, '')}%`;
      foot.append(h('button', { type: 'button', class: 'btn sm split-fill', onclick: () => fillRemainder(p.left) },
        blank(target) ? `Give the remaining ${what} to ${who}` : `Add the remaining ${what} to ${who}`));
    }
  }
  amount.addEventListener('input', update);

  drawSeg();
  drawRows();

  const body = [
    !existing && groupPicker(group, groupId => {
      closeModal();
      openExpenseModal(null, { groupId, draft: { description: desc.value, amount: amount.value, date: date.value, notes: notes.value } });
    }),
    existing && h('p', { class: 'small muted', style: 'margin:0 0 12px' }, `In ${group.name}`),
    field('Description', desc),
    h('div', { class: 'row' }, field('Amount', amountWrap), field('Date', date)),
    field('Paid by', paidBy),
    h('div', { class: 'field', style: 'margin-bottom:6px' }, h('span', {}, 'Split')),
    seg, tools, rowsBox,
    h('div', { style: 'height:14px' }),
    field('Notes', notes),
  ];

  openModal(existing ? 'Edit expense' : 'Add an expense', body,
    h('button', { type: 'submit', class: 'btn primary' }, existing ? 'Save changes' : 'Save'),
    async () => {
      const split = [...S.rows.entries()].filter(([, r]) => r.on).map(([userId, r]) => ({ userId, value: r.value }));
      const payload = {
        description: desc.value, amount: amount.value, paidBy: Number(paidBy.value), date: date.value,
        notes: notes.value, splitType: S.type, split, groupId: group.id,
      };
      if (existing) await api('PUT', `/api/expenses/${existing.id}`, payload);
      else await api('POST', '/api/expenses', payload);
      closeModal();
      toast(existing ? 'Expense updated' : 'Expense added');
      await refresh();
    });
}

// --- settle up --------------------------------------------------------------

async function openPaymentModal(prefill = {}) {
  const group = chooseGroup(prefill.groupId);
  if (!group) return;
  // Suggested amounts come from that group's settlements.
  let settlements;
  try {
    settlements = data.group?.id === group.id ? data.settlements : (await api('GET', `/api/groups/${group.id}/state`)).settlements;
  } catch (ex) { return toast(ex.message, true); }
  setCurrency(group.currency);

  let from = prefill.from, to = prefill.to, amt = prefill.amount;
  if (from === undefined) {
    // Default to settling your own biggest debt, or your biggest credit.
    const mine = settlements.find(s => s.from === me.id) || settlements.find(s => s.to === me.id);
    if (mine) ({ from, to, amount: amt } = mine);
    else { from = me.id; to = pickableMembers(group).find(u => u.id !== me.id)?.id; }
  }
  // Anyone who is or was in the group can pay or be paid (past members may still owe).
  const inGroup = new Set(group.members.map(m => m.userId));
  const people = data.users.filter(u => inGroup.has(u.id) && (u.active || u.id === from || u.id === to));
  const fromSel = userSelect(people, from);
  const toSel = userSelect(people, to);
  const amountWrap = moneyInput({ required: true, value: amt ? inputValue(amt) : '' });
  amountWrap.classList.add('big-amount');
  const date = h('input', { class: 'input', type: 'date', required: true, value: todayISO() });
  const notes = h('input', { class: 'input', maxlength: 500, placeholder: 'Optional (e.g. Venmo)' });

  const hint = h('p', { class: 'small muted', style: 'margin:-4px 0 14px' });
  const updateHint = () => {
    const s = settlements.find(x => x.from === Number(fromSel.value) && x.to === Number(toSel.value));
    hint.replaceChildren();
    if (s) append(hint, [`Suggested: ${money(s.amount)} `, h('button', { type: 'button', class: 'linkish', onclick: () => { amountWrap.querySelector('input').value = inputValue(s.amount); } }, 'use this')]);
  };
  fromSel.addEventListener('change', updateHint);
  toSel.addEventListener('change', updateHint);
  updateHint();

  openModal('Record a payment', [
    groupPicker(group, groupId => { closeModal(); openPaymentModal({ groupId }); }),
    h('div', { class: 'row', style: 'align-items:end' },
      field('Who paid', fromSel),
      h('div', { style: 'flex:0 0 auto; padding-bottom:22px; color:var(--muted)' }, icon('arrow')),
      field('Paid to', toSel)),
    field('Amount', amountWrap),
    hint,
    h('div', { class: 'row' }, field('Date', date), field('Note', notes)),
  ], h('button', { type: 'submit', class: 'btn primary' }, 'Save payment'), async () => {
    await api('POST', '/api/payments', {
      groupId: group.id,
      fromUser: Number(fromSel.value), toUser: Number(toSel.value),
      amount: amountWrap.querySelector('input').value, date: date.value, notes: notes.value,
    });
    closeModal();
    toast('Payment recorded');
    await refresh();
  });
}

// --- change password ---------------------------------------------------------

// --- Telegram notifications ----------------------------------------------------

async function openTelegramModal() {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  let poll = null;
  const stopPolling = () => { clearInterval(poll); poll = null; };
  const form = openModal('Telegram notifications', body,
    h('button', { type: 'submit', class: 'btn primary' }, 'Done'), async () => { stopPolling(); closeModal(); });
  // Stop polling however the modal closes.
  new MutationObserver((_, obs) => { if (!form.isConnected) { stopPolling(); obs.disconnect(); } })
    .observe($('#modal-root'), { childList: true });

  const explain = h('p', { class: 'small muted' },
    'You’ll get a Telegram message whenever someone adds, edits or deletes an expense or payment you’re part of — with your new share and balance. Nothing is sent for your own changes.');

  async function draw() {
    let st;
    try { st = await api('GET', '/api/me/telegram'); } catch (ex) { body.replaceChildren(h('p', { class: 'error-msg' }, ex.message)); return; }
    if (!st.available) {
      stopPolling();
      body.replaceChildren(h('p', {}, 'Telegram notifications aren’t switched on for this site yet.'),
        h('p', { class: 'small muted' }, me.isAdmin ? 'See the Telegram section on the Admin page.' : 'Ask an admin to set them up.'));
      return;
    }
    if (st.connected) {
      stopPolling();
      body.replaceChildren(
        h('p', { class: 'tg-status ok' }, '✅ Connected', st.tgName && ` as ${st.tgName}`),
        explain,
        h('div', { class: 'detail-actions', style: 'margin-top:14px' },
          h('button', { type: 'button', class: 'btn sm', onclick: async () => {
            try { await api('POST', '/api/me/telegram/test'); toast('Test message sent'); } catch (ex) { toast(ex.message, true); }
          } }, 'Send a test message'),
          h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
            try { await api('DELETE', '/api/me/telegram'); toast('Telegram disconnected'); draw(); } catch (ex) { toast(ex.message, true); }
          } }, 'Disconnect')));
      return;
    }
    if (TG.inTelegram) {
      body.replaceChildren(explain, h('button', { type: 'button', class: 'btn primary block tg-connect', onclick: async () => {
        try { await api('POST', '/api/me/telegram/webapp-link', { initData: TG.initData }); toast('Telegram connected'); draw(); }
        catch (ex) { toast(ex.message, true); }
      } }, 'Connect this Telegram account'));
      return;
    }
    if (poll) return; // already showing the connect link and waiting
    let url;
    try { url = (await api('POST', '/api/me/telegram/link')).url; } catch (ex) { body.replaceChildren(h('p', { class: 'error-msg' }, ex.message)); return; }
    body.replaceChildren(
      explain,
      h('a', { class: 'btn primary block tg-connect', href: url, target: '_blank', rel: 'noopener' }, 'Open Telegram to connect'),
      h('p', { class: 'small muted', style: 'margin:10px 0 0' },
        'Tap ', h('b', {}, 'Start'), ' in the chat that opens. This window updates by itself once you’re connected. The link works for 15 minutes.'));
    poll = setInterval(async () => {
      try { if ((await api('GET', '/api/me/telegram')).connected) { stopPolling(); toast('Telegram connected'); draw(); } } catch { /* keep trying */ }
    }, 2500);
  }
  draw();
}

function telegramAdminCard() {
  const card = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Telegram notifications')),
    h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Checking…')));
  const bodyEl = card.lastChild;
  const row = (label, value) => h('div', { class: 'tg-row' }, h('span', { class: 'muted' }, label), h('span', {}, value));

  async function draw() {
    let st;
    try { st = await api('GET', '/api/admin/telegram'); } catch (ex) { bodyEl.replaceChildren(h('p', { class: 'error-msg' }, ex.message)); return; }
    if (!st.configured) {
      bodyEl.replaceChildren(
        h('p', {}, 'Off — no bot token is set.'),
        h('p', { class: 'small muted' }, 'Create a bot with @BotFather in Telegram, then store its token as the ',
          h('code', {}, 'TELEGRAM_BOT_TOKEN'), ' secret (', h('code', {}, 'npx wrangler secret put TELEGRAM_BOT_TOKEN'), ') and deploy.'));
      return;
    }
    if (st.tokenError) {
      bodyEl.replaceChildren(h('p', { class: 'error-msg' }, st.tokenError), h('p', { class: 'small muted' }, 'Check the TELEGRAM_BOT_TOKEN secret.'));
      return;
    }
    const setup = h('button', { class: 'btn sm primary', onclick: async () => {
      setup.disabled = true;
      try { await api('POST', '/api/admin/telegram/webhook'); toast('Bot connected to this site'); draw(); }
      catch (ex) { toast(ex.message, true); setup.disabled = false; }
    } }, st.webhookOk ? 'Reconnect bot' : 'Connect bot to this site');
    const photo = h('button', { class: 'btn sm', onclick: async () => {
      photo.disabled = true;
      try { await api('POST', '/api/admin/telegram/photo'); toast('Bot picture updated'); }
      catch (ex) { toast(ex.message, true); }
      photo.disabled = false;
    } }, 'Set bot picture to the app icon');
    bodyEl.replaceChildren();
    append(bodyEl, [
      row('Bot', h('a', { href: `https://t.me/${st.bot}`, target: '_blank', rel: 'noopener', class: 'linkish' }, `@${st.bot}`)),
      row('Receiving messages', st.webhookOk ? '✅ Yes' : '⚠️ Not yet — connect the bot below'),
      row('People connected', String(st.connectedPeople)),
      st.lastError && row('Last error from Telegram', st.lastError),
      h('div', { class: 'detail-actions', style: 'margin-top:12px' }, setup, photo),
      !st.webhookOk && h('p', { class: 'small muted', style: 'margin:8px 0 0' },
        'This tells Telegram to deliver messages sent to the bot (like the “Start” that connects someone) to this site.'),
    ]);
  }
  draw();
  return card;
}

function openNameModal() {
  const name = h('input', { class: 'input', required: true, maxlength: 60, value: me.name, autocomplete: 'name' });
  openModal('Change display name', [
    field('Display name', name),
    h('p', { class: 'small muted', style: 'margin:-6px 0 0' },
      `This is how you appear to everyone, including in Telegram messages. You still log in as @${me.username}.`),
  ], h('button', { type: 'submit', class: 'btn primary' }, 'Save'), async () => {
    const updated = await api('PATCH', '/api/me', { name: name.value });
    me.name = updated.name;
    closeModal();
    toast('Display name updated');
    await refresh();
  });
}

function openPasswordModal() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  openModal('Change password', [
    field('Current password', cur), field('New password', next), field('Repeat new password', again),
  ], h('button', { type: 'submit', class: 'btn primary' }, 'Change password'), async () => {
    if (next.value !== again.value) throw new Error('New passwords don’t match.');
    await api('POST', '/api/me/password', { current: cur.value, next: next.value });
    closeModal();
    toast('Password changed');
  });
}

// ---------------------------------------------------------------------------
// Admin

let adminUsers = null;
let adminTelegramOn = false;

// A personal t.me link that connects someone's Telegram to their account (no website needed).
async function openInviteModal(u) {
  let invite;
  try { invite = await api('POST', `/api/admin/users/${u.id}/telegram-invite`); } catch (ex) { return toast(ex.message, true); }
  const days = Math.round((invite.expiresAt - Date.now()) / 86400_000);
  const linkBox = h('input', { class: 'input num', readonly: true, value: invite.url, onfocus: e => e.target.select() });
  const copy = h('button', { type: 'button', class: 'btn sm primary', onclick: async () => {
    try { await navigator.clipboard.writeText(invite.url); toast('Link copied'); }
    catch { linkBox.select(); toast('Select the link and copy it', true); }
  } }, 'Copy link');
  const share = navigator.share && h('button', { type: 'button', class: 'btn sm', onclick: () => {
    navigator.share({ title: 'Splitwise', text: `Hi ${u.name}! Tap this to join our Splitwise on Telegram:`, url: invite.url }).catch(() => {});
  } }, 'Share…');
  openModal(`Telegram invite for ${u.name}`, [
    h('p', { style: 'margin-top:0' }, `Send ${u.name} this link. When they open it and tap `, h('b', {}, 'Start'),
      ', their Telegram is connected to this account — they’ll get notifications, and ', h('b', {}, 'Open Splitwise'),
      ' in the bot signs them straight in. No website or password needed.'),
    linkBox,
    h('div', { class: 'detail-actions', style: 'margin-top:10px' }, copy, share),
    h('p', { class: 'small muted', style: 'margin:12px 0 0' }, `Works once, for ${days} days. Making a new link cancels this one.`),
  ], h('button', { type: 'submit', class: 'btn primary' }, 'Done'), async () => { closeModal(); await reloadAdmin(); });
}

function renderAdmin(main) {
  main.append(h('div', { class: 'page-head' },
    h('h1', {}, 'People'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => openUserModal() }, icon('plus', 16), 'Add person'))));

  const card = h('section', { class: 'card' }, h('div', { class: 'empty' }, 'Loading…'));
  main.append(card);

  const draw = () => {
    card.replaceChildren(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', { class: 'hide-sm' }, 'Username'), h('th', {}, 'Role'), h('th', {}, ''))),
      h('tbody', {}, adminUsers.map(u => h('tr', { class: u.active ? '' : 'inactive' },
        h('td', {}, h('div', { class: 'user-cell' }, avatar(u), h('div', {}, h('strong', {}, u.name), u.id === me.id && h('span', { class: 'small muted' }, ' (you)')))),
        h('td', { class: 'hide-sm muted' }, `@${u.username}`),
        h('td', {}, u.isAdmin ? h('span', { class: 'badge admin' }, 'Admin') : h('span', { class: 'badge' }, 'Member'), ' ',
          !u.active && h('span', { class: 'badge off' }, 'Deactivated'), ' ',
          u.hasTelegram && h('span', { class: 'badge tg', title: 'Connected to Telegram' }, 'Telegram'), ' ',
          !u.hasPassword && h('span', { class: 'badge', title: 'Can only sign in through Telegram' }, 'No password')),
        h('td', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: () => openUserModal(u) }, 'Edit'), ' ',
          u.id !== me.id && (u.active
            ? h('button', { class: 'btn sm', onclick: () => setActive(u, false) }, 'Deactivate')
            : h('button', { class: 'btn sm', onclick: () => setActive(u, true) }, 'Reactivate')), ' ',
          u.active && adminTelegramOn && h('button', { class: 'btn sm', onclick: () => openInviteModal(u) }, u.hasTelegram ? 'New Telegram link' : 'Telegram invite'), ' ',
          u.id !== me.id && !u.hasActivity && h('button', { class: 'btn sm danger', onclick: () => deleteUser(u) }, 'Delete')))))));
  };

  Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/me/telegram').catch(() => ({}))])
    .then(([list, tg]) => { adminUsers = list; adminTelegramOn = !!tg.available; draw(); })
    .catch(ex => card.replaceChildren(h('div', { class: 'empty' }, ex.message)));
  if (adminUsers) draw();

  main.append(h('p', { class: 'small muted' },
    'Deactivated people can’t log in or be added to new expenses, but their history and balances stay. ',
    'People with no expenses or payments can be deleted outright.'));
  main.append(h('div', { style: 'height:12px' }), allGroupsCard(), telegramAdminCard());
}

function allGroupsCard() {
  const card = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `All groups (${data.groups.length})`),
      h('button', { class: 'btn sm', onclick: () => openGroupModal() }, icon('plus', 14), 'New group')));
  if (!data.groups.length) {
    card.append(h('div', { class: 'empty' }, 'No groups yet.'));
    return card;
  }
  card.append(h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Group'), h('th', { class: 'hide-sm' }, 'Members'), h('th', { class: 'hide-sm' }, 'Currency'), h('th', {}, ''))),
    h('tbody', {}, data.groups.map(g => h('tr', { class: g.archived ? 'inactive' : '' },
      h('td', {}, h('a', { href: `#/groups/${g.id}`, class: 'linkish' }, g.name), ' ', g.archived && h('span', { class: 'badge off' }, 'Archived')),
      h('td', { class: 'hide-sm' }, h('div', { class: 'member-strip compact' }, g.members.filter(m => !m.past).map(m => avatar(userById(m.userId), 'sm')))),
      h('td', { class: 'hide-sm muted' }, g.currency),
      h('td', { class: 'actions' }, h('a', { class: 'btn sm', href: `#/groups/${g.id}` }, 'Open')))))));
  return card;
}

// Create a group, or edit one (details, members, archive, delete).
function openGroupModal(existing) {
  const g = existing;
  const state = g && data.group?.id === g.id ? data.group : null; // has hasActivity
  const hasActivity = state ? state.hasActivity : true;
  const locked = !!g?.archived;
  // Empty groups: any member. Groups with history: admins or the group's creator.
  const canDeleteGroup = g && (!hasActivity || me.isAdmin || g.createdBy === me.id);

  const recent = [...data.groups].sort((a, b) => b.id - a.id)[0];
  const name = h('input', { class: 'input', required: true, maxlength: 60, placeholder: 'e.g. Ski trip, Apartment', value: g?.name || '' });
  const names = new Intl.DisplayNames(undefined, { type: 'currency' });
  const initialCurrency = g?.currency || recent?.currency || 'USD';
  const currency = h('select', { class: 'input' },
    Intl.supportedValuesOf('currency').map(code =>
      h('option', { value: code, selected: code === initialCurrency }, `${code} — ${names.of(code)}`)));
  const description = h('input', { class: 'input', maxlength: 200, placeholder: 'Optional', value: g?.description || '' });

  // Members: active people, plus anyone already in the group.
  const memberOf = new Map((g?.members || []).map(m => [m.userId, m]));
  const people = data.users.filter(u => u.active || memberOf.has(u.id));
  const boxes = new Map();
  const memberList = h('div', { class: 'split-rows' }, people.map(u => {
    const m = memberOf.get(u.id);
    const box = h('input', { type: 'checkbox', checked: g ? (m && !m.past) : u.id === me.id, disabled: locked });
    boxes.set(u.id, box);
    return h('label', { class: 'split-row member-row' },
      h('div', { class: 'who' }, avatar(u, 'sm'), h('span', {}, u.id === me.id ? `${u.name} (you)` : u.name)),
      h('span', { class: 'small muted' }, m?.past ? 'past member' : !u.active ? 'deactivated' : ''),
      box);
  }));

  const dangerZone = g && h('div', { class: 'group-danger' },
    h('button', { type: 'button', class: 'btn sm', onclick: async () => {
      try {
        await api('PATCH', `/api/groups/${g.id}`, { archived: !g.archived });
        closeModal();
        toast(g.archived ? 'Group unarchived' : 'Group archived');
        await refresh();
      } catch (ex) { toast(ex.message, true); }
    } }, g.archived ? 'Unarchive group' : 'Archive group'),
    canDeleteGroup && h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
      if (!hasActivity) {
        if (!(await ask({ title: `Delete ${g.name}?`, message: 'It has no expenses, so nothing else is lost.', confirmLabel: 'Delete group', danger: true }))) return;
      } else {
        const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const n = state ? `${count(data.expenses.length, 'expense')} and ${count(data.payments.length, 'payment')}` : 'all its expenses and payments';
        const typed = await ask({
          title: `Delete ${g.name}?`, danger: true, confirmLabel: 'Delete group', input: { placeholder: g.name },
          message: `This permanently removes ${n} for everyone and can’t be undone. Type the group name to confirm.`,
        });
        if (typed === null) return;
        if (typed.trim() !== g.name) return toast('Name didn’t match — nothing was deleted', true);
      }
      try {
        await api('DELETE', `/api/groups/${g.id}`);
        closeModal();
        toast('Group deleted');
        location.hash = '#/home';
        await refresh();
      } catch (ex) { toast(ex.message, true); }
    } }, 'Delete group'),
    h('p', { class: 'small muted', style: 'margin:8px 0 0' },
      g.archived ? 'Archived groups are read-only.' : 'Groups last until deleted. Archive one to make it read-only and tuck it away.',
      hasActivity && !canDeleteGroup && ' Only its creator or an admin can delete a group with expenses.'));

  openModal(g ? 'Group settings' : 'New group', [
    field('Name', name),
    field('Currency', currency),
    field('Description', description),
    h('div', { class: 'field', style: 'margin-bottom:6px' }, h('span', {}, 'Members')),
    locked && h('p', { class: 'small muted', style: 'margin:0 0 8px' }, 'Unarchive the group to change its members.'),
    memberList,
    h('p', { class: 'small muted', style: 'margin:8px 0 14px' },
      'People who leave but have expenses here stay on as past members, so balances stay correct.'),
    dangerZone,
  ], h('button', { type: 'submit', class: 'btn primary' }, g ? 'Save' : 'Create group'), async () => {
    const memberIds = [...boxes].filter(([, b]) => b.checked).map(([uid]) => uid);
    if (!memberIds.length) throw new Error('Pick at least one member.');
    const fields = { name: name.value, currency: currency.value, description: description.value };
    if (g && g.currency !== currency.value && hasActivity &&
        !(await ask({ title: `Switch to ${currency.value}?`, message: 'Existing amounts keep their numbers — they are not converted.', confirmLabel: 'Switch currency' }))) return;
    if (!g) {
      const { id: newId } = await api('POST', '/api/groups', { ...fields, memberIds });
      closeModal();
      toast(`${fields.name} created`);
      location.hash = `#/groups/${newId}`;
      return; // hashchange refreshes
    }
    await api('PATCH', `/api/groups/${g.id}`, fields);
    const before = g.members.filter(m => !m.past).map(m => m.userId).sort().join();
    if (!locked && before !== [...memberIds].sort().join()) {
      if (!me.isAdmin && !memberIds.includes(me.id) && !(await ask({ title: 'Leave this group?', message: 'You’re removing yourself. You won’t be able to change this group afterwards.', confirmLabel: 'Leave group', danger: true }))) return;
      await api('PUT', `/api/groups/${g.id}/members`, { memberIds });
    }
    closeModal();
    toast('Group saved');
    await refresh();
  });
}

async function reloadAdmin() {
  await refresh(); // re-renders; renderAdmin refetches the list
}

function openUserModal(u) {
  const name = h('input', { class: 'input', required: true, maxlength: 60, value: u?.name || '' });
  const username = h('input', { class: 'input', required: true, maxlength: 32, autocomplete: 'off', value: u?.username || '', disabled: !!u, pattern: '[A-Za-z0-9._\\-]{2,32}' });
  const pw = h('input', { class: 'input', type: 'text', autocomplete: 'new-password', minlength: 6, placeholder: u ? 'Leave blank to keep current' : 'Optional if they’ll only use Telegram' });
  const admin = h('input', { type: 'checkbox', checked: !!u?.isAdmin, disabled: u?.id === me.id });
  const genBtn = h('button', { type: 'button', class: 'linkish small', onclick: () => {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    pw.value = Array.from(crypto.getRandomValues(new Uint32Array(12)), n => chars[n % chars.length]).join('');
  } }, 'Generate one');

  name.addEventListener('input', () => {
    if (u || username.dataset.touched) return;
    username.value = name.value.trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '');
  });
  username.addEventListener('input', () => { username.dataset.touched = '1'; });

  openModal(u ? `Edit ${u.name}` : 'Add a person', [
    field('Name', name),
    field('Username (used to log in)', username),
    h('label', { class: 'field' }, h('span', {}, u ? 'Reset password' : 'Password', ' · ', genBtn), pw),
    h('label', { class: 'check' }, admin, h('span', {}, 'Admin (can manage people)')),
    !u && h('p', { class: 'small muted', style: 'margin:14px 0 0' },
      'With a password, share the username and password with them. Without one, you’ll get a Telegram invite link to send instead.'),
  ], h('button', { type: 'submit', class: 'btn primary' }, u ? 'Save' : 'Add person'), async () => {
    if (u) {
      const patch = { name: name.value };
      if (pw.value) patch.password = pw.value;
      if (u.id !== me.id) patch.isAdmin = admin.checked;
      await api('PATCH', `/api/admin/users/${u.id}`, patch);
      toast(pw.value ? 'Saved — password reset' : 'Saved');
    } else {
      const { id: newId } = await api('POST', '/api/admin/users', { name: name.value, username: username.value, password: pw.value, isAdmin: admin.checked });
      toast(`${name.value} added`);
      if (!pw.value) {
        closeModal();
        await reloadAdmin();
        return openInviteModal({ id: newId, name: name.value });
      }
    }
    closeModal();
    await reloadAdmin();
  });
}

async function setActive(u, active) {
  const question = active
    ? `Reactivate ${u.name}?`
    : `Deactivate ${u.name}? They won't be able to log in. Their expenses and balance stay.`;
  if (!(await ask({ title: active ? 'Reactivate?' : 'Deactivate?', message: question, confirmLabel: active ? 'Reactivate' : 'Deactivate', danger: !active }))) return;
  try {
    await api('PATCH', `/api/admin/users/${u.id}`, { active });
    toast(active ? `${u.name} reactivated` : `${u.name} deactivated`);
    await reloadAdmin();
  } catch (ex) { toast(ex.message, true); }
}

async function deleteUser(u) {
  if (!(await ask({ title: `Delete ${u.name}?`, message: 'This permanently removes their account.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await api('DELETE', `/api/admin/users/${u.id}`);
    toast(`${u.name} deleted`);
    await reloadAdmin();
  } catch (ex) { toast(ex.message, true); }
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  // Opened from the Telegram bot: a connected account is signed in without a password.
  if (TG.inTelegram && !bearerToken) {
    try {
      const r = await api('POST', '/api/telegram/webapp-login', { initData: TG.initData });
      if (r.linked) setBearer(r.token);
    } catch { /* fall back to the password form */ }
  }
  try {
    me = await api('GET', '/api/me');
  } catch {
    return; // api() already showed the login screen on 401
  }
  await refresh();
}

window.addEventListener('hashchange', () => {
  expanded.clear();
  closeModal();
  if (me) refresh().catch(ex => toast(ex.message, true));
});
boot().catch(ex => {
  $('#app').replaceChildren(h('div', { class: 'boot' }, `Couldn't load: ${ex.message}`));
});
