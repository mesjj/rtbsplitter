// Money math. Everything is integer cents so there's never any float drift.

const SPLIT_TYPES = ['equal', 'exact', 'percent', 'shares'];
const MAX_CENTS = 1_000_000_000; // $10M per expense is plenty

// Amounts are stored in hundredths. For currencies with no minor unit (JPY, KRW…)
// every amount must be a whole number, i.e. a multiple of 100 hundredths.
function currencyUnit(code) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  return digits === 0 ? 100 : 1;
}

function isValidCurrency(code) {
  return typeof code === 'string' && Intl.supportedValuesOf('currency').includes(code);
}

// Split `total` cents proportionally to integer `weights` using the
// largest-remainder method, so the parts always add up to exactly `total`.
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('weights must add up to more than zero');
  const parts = weights.map(w => Math.floor((total * w) / sum));
  let leftover = total - parts.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; leftover > 0; k = (k + 1) % order.length, leftover--) {
    parts[order[k].i] += 1;
  }
  return parts;
}

// Turn "12.34" / 12.34 into 1234. Returns NaN for junk.
function toCents(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

// Validate a split request and compute each person's share in cents.
//   entries: [{ userId, value }]  where value meaning depends on type:
//     equal   – ignored (every listed user shares equally)
//     exact   – amount in dollars owed by that user
//     percent – percentage of the total
//     shares  – relative weight (e.g. 2 and 1 → two thirds / one third)
// Returns [{ userId, cents, value }] or throws Error with a user-facing message.
//   unit: smallest allowed amount (see currencyUnit), default 1 cent.
function computeShares(totalCents, type, entries, { unit = 1 } = {}) {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new Error('Amount must be greater than zero.');
  if (totalCents % unit) throw new Error('This currency has no decimals — use a whole number.');
  const split = weights => allocate(totalCents / unit, weights).map(p => p * unit);
  if (totalCents > MAX_CENTS) throw new Error('Amount is too large.');
  if (!SPLIT_TYPES.includes(type)) throw new Error('Unknown split type.');
  if (!Array.isArray(entries) || !entries.length) throw new Error('Pick at least one person to split with.');
  const ids = entries.map(e => e.userId);
  if (new Set(ids).size !== ids.length) throw new Error('Each person can only appear once in a split.');

  if (type === 'equal') {
    const parts = split(entries.map(() => 1));
    return entries.map((e, i) => ({ userId: e.userId, cents: parts[i], value: null }));
  }

  // All other types: scale the input to an integer (hundredths) and validate.
  const scaled = entries.map(e => toCents(e.value));
  if (scaled.some(v => Number.isNaN(v) || v < 0)) throw new Error('Every split value must be a number of zero or more.');
  const kept = entries
    .map((e, i) => ({ userId: e.userId, scaled: scaled[i] }))
    .filter(e => e.scaled > 0);
  if (!kept.length) throw new Error('At least one person needs a non-zero share.');
  const sum = kept.reduce((a, e) => a + e.scaled, 0);

  if (type === 'exact') {
    if (sum !== totalCents) {
      const diff = (totalCents - sum) / 100;
      throw new Error(`Amounts add up to ${(sum / 100).toFixed(2)} but the total is ${(totalCents / 100).toFixed(2)} (${diff > 0 ? diff.toFixed(2) + ' left' : (-diff).toFixed(2) + ' over'}).`);
    }
    if (kept.some(e => e.scaled % unit)) throw new Error('This currency has no decimals — use whole numbers.');
    return kept.map(e => ({ userId: e.userId, cents: e.scaled, value: e.scaled / 100 }));
  }

  if (type === 'percent' && sum !== 10000) {
    throw new Error(`Percentages add up to ${(sum / 100).toFixed(2)}% — they need to total 100%.`);
  }
  const parts = split(kept.map(e => e.scaled));
  return kept.map((e, i) => ({ userId: e.userId, cents: parts[i], value: e.scaled / 100 }));
}

// Net balance per user: positive = is owed money, negative = owes money.
//   expenses: [{ paidBy, amount, shares: [{ userId, cents }] }]
//   payments: [{ fromUser, toUser, amount }]  (fromUser paid toUser back)
function netBalances(expenses, payments) {
  const net = new Map();
  const add = (id, cents) => net.set(id, (net.get(id) || 0) + cents);
  for (const e of expenses) {
    add(e.paidBy, e.amount);
    for (const s of e.shares) add(s.userId, -s.cents);
  }
  for (const p of payments) {
    add(p.fromUser, p.amount);
    add(p.toUser, -p.amount);
  }
  return net;
}

// "Simplify debts": greedily match the largest debtor with the largest creditor.
// Produces at most n-1 transfers that fully settle everyone.
function simplifyDebts(net) {
  const debtors = [];
  const creditors = [];
  for (const [id, cents] of net) {
    if (cents < 0) debtors.push({ id, cents: -cents });
    else if (cents > 0) creditors.push({ id, cents });
  }
  const byAmount = (a, b) => b.cents - a.cents || String(a.id).localeCompare(String(b.id));
  debtors.sort(byAmount);
  creditors.sort(byAmount);

  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].cents, creditors[j].cents);
    transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].cents -= pay;
    creditors[j].cents -= pay;
    if (debtors[i].cents === 0) i++;
    if (creditors[j].cents === 0) j++;
  }
  return transfers;
}

export { SPLIT_TYPES, MAX_CENTS, currencyUnit, isValidCurrency, allocate, toCents, computeShares, netBalances, simplifyDebts };
