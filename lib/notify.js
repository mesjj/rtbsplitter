// Builds the Telegram messages sent when expenses, payments or groups change.
// Everyone involved gets their own message ("your share", "your balance"); whoever made
// the change gets none.

import { escapeHtml as esc } from './telegram.js';
import { currencyUnit } from './money.js';

const SPLIT_LABEL = { equal: 'split equally', exact: 'split by exact amounts', percent: 'split by percentage', shares: 'split by shares' };

// --- snapshots (taken before and after a change) ---------------------------

export async function expenseSnapshot(db, expenseId) {
  const e = await db.get('SELECT id, group_id, description, amount, paid_by, split_type, date FROM expenses WHERE id = ?', expenseId);
  if (!e) return null;
  const shares = await db.all('SELECT user_id, cents FROM expense_shares WHERE expense_id = ?', expenseId);
  return {
    id: e.id, groupId: e.group_id, description: e.description, amount: e.amount, paidBy: e.paid_by,
    splitType: e.split_type, date: e.date, shares: new Map(shares.map(s => [s.user_id, s.cents])),
  };
}

export async function paymentSnapshot(db, paymentId) {
  const p = await db.get('SELECT id, group_id, from_user, to_user, amount FROM payments WHERE id = ?', paymentId);
  return p && { id: p.id, groupId: p.group_id, fromUser: p.from_user, toUser: p.to_user, amount: p.amount };
}

// Everyone with any history in a group, plus counts — taken before the group is deleted.
export async function groupSnapshot(db, groupId) {
  const g = await db.get('SELECT id, name FROM groups WHERE id = ?', groupId);
  const rows = await db.all(`SELECT paid_by AS uid FROM expenses WHERE group_id = ?
    UNION SELECT s.user_id FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?
    UNION SELECT from_user FROM payments WHERE group_id = ? UNION SELECT to_user FROM payments WHERE group_id = ?`,
  groupId, groupId, groupId, groupId);
  const { e, p } = await db.get('SELECT (SELECT COUNT(*) FROM expenses WHERE group_id = ?) AS e, (SELECT COUNT(*) FROM payments WHERE group_id = ?) AS p', groupId, groupId);
  return { id: g.id, name: g.name, involved: rows.map(r => r.uid), expenses: e, payments: p };
}

// --- shared helpers ------------------------------------------------------------

async function context(db, groupId, appUrl) {
  const [group, users, balanceRows] = await Promise.all([
    db.get('SELECT id, name, currency FROM groups WHERE id = ?', groupId),
    db.all('SELECT id, name FROM users'),
    db.all(`SELECT uid, SUM(c) AS bal FROM (
        SELECT paid_by AS uid, amount AS c FROM expenses WHERE group_id = ?
        UNION ALL SELECT s.user_id, -s.cents FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?
        UNION ALL SELECT from_user, amount FROM payments WHERE group_id = ?
        UNION ALL SELECT to_user, -amount FROM payments WHERE group_id = ?
      ) GROUP BY uid`, groupId, groupId, groupId, groupId),
  ]);
  const unit = currencyUnit(group.currency);
  // narrowSymbol: ฿ rather than "THB", € rather than "EUR".
  const fmt = new Intl.NumberFormat('en', {
    style: 'currency', currency: group.currency, currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: unit === 1 ? 2 : 0, maximumFractionDigits: 2,
  });
  const names = new Map(users.map(u => [u.id, u.name]));
  const balances = new Map(balanceRows.map(r => [r.uid, r.bal]));
  return {
    group,
    money: c => fmt.format(c / 100),
    // "you" for the reader, otherwise their name; `cap` for the start of a sentence.
    who: (uid, reader, cap = false) => (uid === reader ? (cap ? 'You' : 'you') : esc(names.get(uid) || 'Someone')),
    actorName: actor => esc(actor.name),
    balanceLine(reader) {
      const b = balances.get(reader) || 0;
      const state = b > 0 ? `you're owed <b>${fmt.format(b / 100)}</b>` : b < 0 ? `you owe <b>${fmt.format(-b / 100)}</b>` : 'you\'re settled up';
      return `Your balance in ${esc(group.name)}: ${state}`;
    },
    link: tab => `<a href="${esc(appUrl)}/#/groups/${group.id}${tab ? `/${tab}` : ''}">Open in Splitwise</a>`,
  };
}

const recipients = (ids, actor) => [...new Set(ids)].filter(id => id && id !== actor.id);

// --- expenses --------------------------------------------------------------------

// action: 'added' | 'edited' | 'deleted'. `before` is null when added, `after` null when deleted.
export async function expenseMessages(db, { action, actor, before, after, appUrl }) {
  const cur = after || before;
  const c = await context(db, cur.groupId, appUrl);
  const people = recipients([
    before?.paidBy, after?.paidBy, ...(before ? before.shares.keys() : []), ...(after ? after.shares.keys() : []),
  ], actor);
  const head = { added: '💸', edited: '✏️', deleted: '🗑' }[action];

  return people.map(reader => {
    const lines = [];
    if (action === 'added') {
      lines.push(`${head} <b>${c.actorName(actor)}</b> added <b>${esc(after.description)}</b> in <i>${esc(c.group.name)}</i>`);
      lines.push(`${c.who(after.paidBy, reader, true)} paid ${c.money(after.amount)} · ${SPLIT_LABEL[after.splitType]}`);
      lines.push(after.shares.has(reader) ? `Your share: <b>${c.money(after.shares.get(reader))}</b>` : 'You\'re not part of the split.');
    } else if (action === 'edited') {
      lines.push(`${head} <b>${c.actorName(actor)}</b> edited <b>${esc(after.description)}</b> in <i>${esc(c.group.name)}</i>`);
      const changes = [];
      if (before.description !== after.description) changes.push(`Name: ${esc(before.description)} → ${esc(after.description)}`);
      if (before.amount !== after.amount) changes.push(`Amount: ${c.money(before.amount)} → ${c.money(after.amount)}`);
      if (before.paidBy !== after.paidBy) changes.push(`Paid by: ${c.who(before.paidBy, reader)} → ${c.who(after.paidBy, reader)}`);
      if (before.splitType !== after.splitType) changes.push(`Split: ${SPLIT_LABEL[before.splitType]} → ${SPLIT_LABEL[after.splitType]}`);
      const was = before.shares.get(reader);
      const now = after.shares.get(reader);
      if (was !== undefined && now !== undefined) {
        changes.push(was === now ? `Your share: ${c.money(now)} (unchanged)` : `Your share: ${c.money(was)} → <b>${c.money(now)}</b>`);
      } else if (now !== undefined) {
        changes.push(`You were added to it — your share is <b>${c.money(now)}</b>`);
      } else if (was !== undefined) {
        changes.push(`You were taken off it (your share was ${c.money(was)})`);
      }
      if (before.date !== after.date) changes.push(`Date: ${before.date} → ${after.date}`);
      lines.push(...(changes.length ? changes : ['Only the notes changed.']));
    } else {
      lines.push(`${head} <b>${c.actorName(actor)}</b> deleted <b>${esc(before.description)}</b> (${c.money(before.amount)}) in <i>${esc(c.group.name)}</i>`);
      const parts = [];
      if (before.paidBy === reader) parts.push('You had paid for it');
      if (before.shares.has(reader)) parts.push(`${parts.length ? 'your' : 'Your'} share was ${c.money(before.shares.get(reader))}`);
      if (parts.length) lines.push(`${parts.join('; ')}.`);
    }
    lines.push('', c.balanceLine(reader), c.link('expenses'));
    return { userId: reader, text: lines.join('\n') };
  });
}

// --- payments --------------------------------------------------------------------

export async function paymentMessages(db, { action, actor, payment, appUrl }) {
  const c = await context(db, payment.groupId, appUrl);
  return recipients([payment.fromUser, payment.toUser], actor).map(reader => {
    const what = `${c.who(payment.fromUser, reader, true)} paid ${c.who(payment.toUser, reader)} <b>${c.money(payment.amount)}</b>`;
    const first = action === 'added'
      ? `✅ <b>${c.actorName(actor)}</b> recorded a payment in <i>${esc(c.group.name)}</i>`
      : `🗑 <b>${c.actorName(actor)}</b> deleted a payment in <i>${esc(c.group.name)}</i>`;
    return { userId: reader, text: [first, what, '', c.balanceLine(reader), c.link('expenses')].join('\n') };
  });
}

// --- groups ----------------------------------------------------------------------

export function groupDeletedMessages({ actor, group }) {
  if (!group.expenses && !group.payments) return [];
  const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return recipients(group.involved, actor).map(reader => ({
    userId: reader,
    text: `🗑 <b>${esc(actor.name)}</b> deleted the group <i>${esc(group.name)}</i>, including its `
      + `${count(group.expenses, 'expense')} and ${count(group.payments, 'payment')}. `
      + 'Any balance you had there is gone with it.',
  }));
}
