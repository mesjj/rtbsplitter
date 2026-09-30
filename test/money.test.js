import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, computeShares, netBalances, simplifyDebts } from '../lib/money.js';

const sum = a => a.reduce((x, y) => x + y, 0);

test('allocate always adds up exactly', () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(1, [1, 1, 1]), [1, 0, 0]);
  for (let t = 1; t < 500; t += 7) assert.equal(sum(allocate(t, [3, 5, 7, 11])), t);
});

test('equal split', () => {
  const s = computeShares(1000, 'equal', [{ userId: 1 }, { userId: 2 }, { userId: 3 }]);
  assert.deepEqual(s.map(x => x.cents), [334, 333, 333]);
});

test('exact split must match the total', () => {
  const ok = computeShares(1000, 'exact', [{ userId: 1, value: '7.50' }, { userId: 2, value: 2.5 }]);
  assert.deepEqual(ok.map(x => x.cents), [750, 250]);
  assert.throws(() => computeShares(1000, 'exact', [{ userId: 1, value: 5 }]), /5.00 left/);
});

test('percent split must total 100', () => {
  const s = computeShares(10000, 'percent', [{ userId: 1, value: 33.33 }, { userId: 2, value: 33.33 }, { userId: 3, value: 33.34 }]);
  assert.equal(sum(s.map(x => x.cents)), 10000);
  assert.deepEqual(s.map(x => x.value), [33.33, 33.33, 33.34]);
  assert.throws(() => computeShares(10000, 'percent', [{ userId: 1, value: 50 }, { userId: 2, value: 40 }]), /90.00%/);
});

test('shares split is proportional; zero-share people are dropped', () => {
  const s = computeShares(900, 'shares', [{ userId: 1, value: 2 }, { userId: 2, value: 1 }, { userId: 3, value: 0 }]);
  assert.deepEqual(s.map(x => [x.userId, x.cents]), [[1, 600], [2, 300]]);
});

test('rejects bad input', () => {
  assert.throws(() => computeShares(0, 'equal', [{ userId: 1 }]));
  assert.throws(() => computeShares(100, 'equal', []));
  assert.throws(() => computeShares(100, 'equal', [{ userId: 1 }, { userId: 1 }]));
  assert.throws(() => computeShares(100, 'bogus', [{ userId: 1 }]));
  assert.throws(() => computeShares(100, 'exact', [{ userId: 1, value: 'abc' }]));
});

test('balances net to zero and simplify to at most n-1 transfers', () => {
  const expenses = [
    { paidBy: 1, amount: 9000, shares: [{ userId: 1, cents: 3000 }, { userId: 2, cents: 3000 }, { userId: 3, cents: 3000 }] },
    { paidBy: 2, amount: 3000, shares: [{ userId: 3, cents: 1500 }, { userId: 4, cents: 1500 }] },
  ];
  const payments = [{ fromUser: 3, toUser: 1, amount: 1000 }];
  const net = netBalances(expenses, payments);
  assert.equal(sum([...net.values()]), 0);
  assert.deepEqual(Object.fromEntries(net), { 1: 5000, 2: 0, 3: -3500, 4: -1500 });

  const t = simplifyDebts(net);
  assert.ok(t.length <= 3);
  // Applying the transfers clears everyone.
  const after = new Map(net);
  for (const x of t) { after.set(x.from, after.get(x.from) + x.amount); after.set(x.to, after.get(x.to) - x.amount); }
  assert.ok([...after.values()].every(v => v === 0));
});

test('zero-decimal currencies split in whole units', () => {
  const unit = 100; // e.g. JPY
  const s = computeShares(10000, 'equal', [{ userId: 1 }, { userId: 2 }, { userId: 3 }], { unit });
  assert.deepEqual(s.map(x => x.cents), [3400, 3300, 3300]);
  assert.ok(s.every(x => x.cents % 100 === 0));
  assert.throws(() => computeShares(1050, 'equal', [{ userId: 1 }], { unit }), /whole number/);
  assert.throws(() => computeShares(1000, 'exact', [{ userId: 1, value: 5.5 }, { userId: 2, value: 4.5 }], { unit }), /whole numbers/);
});
