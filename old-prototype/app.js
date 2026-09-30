// Splitwise Lite — all money is handled in integer cents to avoid float drift.

const STORAGE_KEY = 'splitwise-lite/v1';

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.people) && Array.isArray(parsed.expenses)) return parsed;
    }
  } catch (e) {
    console.warn('Could not read saved data', e);
  }
  return { people: [], expenses: [] };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save data', e);
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);
const money = cents => (cents / 100).toFixed(2);
const personName = id => (state.people.find(p => p.id === id) || {}).name || 'someone';

// --- domain ---------------------------------------------------------------

// Split `total` cents between `n` people; the first `total % n` people pay 1c more.
function shares(total, n) {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// Net position per person: positive = owed money, negative = owes money.
function balances() {
  const net = new Map(state.people.map(p => [p.id, 0]));
  for (const e of state.expenses) {
    const parts = e.participantIds.filter(id => net.has(id));
    if (!parts.length || !net.has(e.payerId)) continue;
    net.set(e.payerId, net.get(e.payerId) + e.amount);
    shares(e.amount, parts.length).forEach((share, i) => {
      net.set(parts[i], net.get(parts[i]) - share);
    });
  }
  return net;
}

// Greedy settle-up: repeatedly match the biggest debtor with the biggest creditor.
function settlements(net) {
  const debtors = [];
  const creditors = [];
  for (const [id, amount] of net) {
    if (amount < 0) debtors.push({ id, amount: -amount });
    else if (amount > 0) creditors.push({ id, amount });
  }
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return out;
}

// --- rendering ------------------------------------------------------------

const $ = sel => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const emptyItem = text => {
  const li = el('li');
  li.append(el('span', 'empty', text));
  return li;
};

function renderPeople() {
  const ul = $('#people');
  ul.replaceChildren();
  if (!state.people.length) {
    ul.append(emptyItem('Nobody yet — add someone to get started.'));
    return;
  }
  for (const p of state.people) {
    const li = el('li');
    li.append(el('span', null, p.name));
    const remove = el('button', null, '×');
    remove.type = 'button';
    remove.title = `Remove ${p.name}`;
    remove.addEventListener('click', () => removePerson(p.id));
    li.append(remove);
    ul.append(li);
  }
}

function renderExpenseForm() {
  const payer = $('#payer');
  const previousPayer = payer.value;
  payer.replaceChildren();
  for (const p of state.people) {
    payer.append(new Option(p.name, p.id));
  }
  if (state.people.some(p => p.id === previousPayer)) payer.value = previousPayer;

  const checked = new Set(
    [...document.querySelectorAll('#participants input:checked')].map(i => i.value)
  );
  const box = $('#participants');
  const first = !box.children.length;
  box.replaceChildren();
  for (const p of state.people) {
    const label = el('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = p.id;
    // Newly added people join the split by default.
    input.checked = first || checked.has(p.id) || !checked.size;
    label.append(input, el('span', null, p.name));
    box.append(label);
  }
  if (!state.people.length) box.append(el('span', 'empty', 'Add people first.'));
}

function renderExpenses() {
  const ul = $('#expenses');
  ul.replaceChildren();
  if (!state.expenses.length) {
    ul.append(emptyItem('No expenses yet.'));
    return;
  }
  for (const e of [...state.expenses].reverse()) {
    const li = el('li');
    const main = el('div', 'grow');
    main.append(el('strong', null, e.description));
    main.append(el('span', 'sub',
      `${personName(e.payerId)} paid · split ${e.participantIds.length} ways`));
    li.append(main, el('span', 'amount', `$${money(e.amount)}`));
    const remove = el('button', 'link-btn', 'delete');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      state.expenses = state.expenses.filter(x => x.id !== e.id);
      save();
      render();
    });
    li.append(remove);
    ul.append(li);
  }
}

function renderBalances() {
  const net = balances();
  const ul = $('#balances');
  ul.replaceChildren();
  if (!state.people.length) {
    ul.append(emptyItem('No balances yet.'));
  } else {
    for (const p of state.people) {
      const amount = net.get(p.id) || 0;
      const li = el('li');
      li.append(el('span', 'grow', p.name));
      const label = amount === 0 ? 'settled up'
        : amount > 0 ? `gets back $${money(amount)}`
        : `owes $${money(-amount)}`;
      li.append(el('span', `amount ${amount > 0 ? 'pos' : amount < 0 ? 'neg' : ''}`, label));
      ul.append(li);
    }
  }

  const list = $('#settlements');
  list.replaceChildren();
  const plan = settlements(net);
  if (!plan.length) {
    list.append(emptyItem('Everyone is square.'));
    return;
  }
  for (const s of plan) {
    const li = el('li');
    li.append(el('span', 'grow', `${personName(s.from)} → ${personName(s.to)}`));
    li.append(el('span', 'amount', `$${money(s.amount)}`));
    list.append(li);
  }
}

function render() {
  renderPeople();
  renderExpenseForm();
  renderExpenses();
  renderBalances();
}

// --- actions --------------------------------------------------------------

function removePerson(id) {
  const involved = state.expenses.some(
    e => e.payerId === id || e.participantIds.includes(id)
  );
  if (involved && !confirm(`${personName(id)} appears in expenses. Remove them and those expenses?`)) return;
  state.people = state.people.filter(p => p.id !== id);
  state.expenses = state.expenses.filter(
    e => e.payerId !== id && !e.participantIds.includes(id)
  );
  save();
  render();
}

$('#person-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#person-name');
  const name = input.value.trim();
  if (!name) return;
  if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    input.value = '';
    return;
  }
  state.people.push({ id: uid(), name });
  input.value = '';
  save();
  render();
});

$('#toggle-all').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#participants input')];
  const turnOn = boxes.some(b => !b.checked);
  boxes.forEach(b => { b.checked = turnOn; });
});

$('#expense-form').addEventListener('submit', event => {
  event.preventDefault();
  const error = $('#expense-error');
  const fail = message => {
    error.textContent = message;
    error.hidden = false;
  };
  error.hidden = true;

  const description = $('#desc').value.trim();
  const amount = Math.round(parseFloat($('#amount').value) * 100);
  const payerId = $('#payer').value;
  const participantIds = [...document.querySelectorAll('#participants input:checked')]
    .map(i => i.value);

  if (!description) return fail('Give the expense a description.');
  if (!Number.isFinite(amount) || amount <= 0) return fail('Enter an amount greater than zero.');
  if (!payerId) return fail('Add at least one person first.');
  if (!participantIds.length) return fail('Pick at least one person to split between.');

  state.expenses.push({ id: uid(), description, amount, payerId, participantIds });
  $('#desc').value = '';
  $('#amount').value = '';
  save();
  render();
});

$('#reset').addEventListener('click', () => {
  if (!confirm('Delete all people and expenses?')) return;
  state = { people: [], expenses: [] };
  save();
  render();
});

render();
