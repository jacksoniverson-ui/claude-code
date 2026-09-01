const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/domain.js');

/** A room with one batch weighed in and one station running. */
function room({ intakeG = 10000, issuedG = 2000 } = {}) {
  const state = C.createState();
  const batch = C.openBatch(state, { tag: 'HL-0001', strain: 'Blue Dream', intakeG });
  const session = C.openSession(state, { batchId: batch.id, trimmer: 'Ana', station: '1', issuedG });
  return { state, batch, session };
}

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => err instanceof C.CanopyError && err.code === code, `expected ${code}`);

test('round2 keeps sums from drifting', () => {
  assert.equal(C.round2(0.1 + 0.2), 0.3);
  assert.equal(C.round2(1.005), 1.01);
  assert.equal(C.round2(-1.005), -1.01);
  assert.equal(C.sum([0.1, 0.2, 0.3]), 0.6);
  // 300 scale readings must not accumulate float error.
  assert.equal(C.sum(new Array(300).fill(0.01)), 3);
});

test('unit conversion round-trips pounds and ounces', () => {
  assert.equal(C.toGrams(1, 'lb'), 453.59);
  assert.equal(C.toGrams(1, 'oz'), 28.35);
  assert.equal(C.toGrams(2.5, 'g'), 2.5);
  assert.equal(C.fromGrams(453.59237, 'lb'), 1);
  throwsCode(() => C.toGrams(1, 'kilos'), 'UNIT');
});

test('a batch weighs in and hands out ids', () => {
  const { state, batch } = room();
  assert.equal(batch.id, 'B-0001');
  assert.equal(batch.status, 'open');
  assert.equal(C.reconcileBatch(state, batch.id).intakeG, 10000);
});

test('batch tags are unique and required fields are enforced', () => {
  const { state } = room();
  throwsCode(() => C.openBatch(state, { tag: 'hl-0001', strain: 'X', intakeG: 100 }), 'DUPLICATE');
  throwsCode(() => C.openBatch(state, { tag: '', strain: 'X', intakeG: 100 }), 'REQUIRED');
  throwsCode(() => C.openBatch(state, { tag: 'T2', strain: 'X', intakeG: 0 }), 'WEIGHT');
  throwsCode(() => C.openBatch(state, { tag: 'T3', strain: 'X', intakeG: -5 }), 'WEIGHT');
  throwsCode(() => C.openBatch(state, { tag: 'T4', strain: 'X', intakeG: 'heavy' }), 'WEIGHT');
});

test('the four streams tally separately', () => {
  const { state, session } = room();
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 700 });
  C.addEntry(state, { sessionId: session.id, category: 'B', grams: 300 });
  C.addEntry(state, { sessionId: session.id, category: 'TRIM', grams: 450 });
  C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 500, wasteReason: 'STEM' });

  const totals = C.sessionTotals(state, session.id);
  assert.equal(totals.A, 700);
  assert.equal(totals.B, 300);
  assert.equal(totals.TRIM, 450);
  assert.equal(totals.WASTE, 500);
  assert.equal(totals.product, 1450, 'product excludes waste');
  assert.equal(totals.output, 1950);
  assert.equal(totals.count, 4);
});

test('waste always carries a reason code', () => {
  const { state, session } = room();
  throwsCode(() => C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 10 }), 'WASTE_REASON');
  throwsCode(
    () => C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 10, wasteReason: 'NOPE' }),
    'WASTE_REASON'
  );
  throwsCode(
    () => C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 10, wasteReason: 'OTHER' }),
    'WASTE_REASON'
  );
  const ok = C.addEntry(state, {
    sessionId: session.id,
    category: 'WASTE',
    grams: 10,
    wasteReason: 'other',
    note: 'dropped tray',
  });
  assert.equal(ok.wasteReason, 'OTHER');
});

test('unknown categories and closed stations are refused', () => {
  const { state, session } = room();
  throwsCode(() => C.addEntry(state, { sessionId: session.id, category: 'SHAKE', grams: 5 }), 'CATEGORY');
  throwsCode(() => C.addEntry(state, { sessionId: 'S-9999', category: 'A', grams: 5 }), 'NOT_FOUND');
  C.closeSession(state, session.id, { returnedG: 2000 });
  throwsCode(() => C.addEntry(state, { sessionId: session.id, category: 'A', grams: 5 }), 'CLOSED');
});

test('a station cannot weigh out more than was issued to it', () => {
  const { state, session } = room({ issuedG: 1000 });
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 900 });
  // A 1000 g typo for 100 g would silently corrupt the batch reconciliation.
  throwsCode(() => C.addEntry(state, { sessionId: session.id, category: 'B', grams: 1000 }), 'OVER_ISSUE');
  // Override exists for the genuine case: material carried over from a re-weigh.
  const forced = C.addEntry(state, { sessionId: session.id, category: 'B', grams: 1000, allowOverIssue: true });
  assert.equal(forced.grams, 1000);
});

test('closing a station returns unprocessed material to the batch', () => {
  const { state, batch, session } = room({ intakeG: 10000, issuedG: 2000 });
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 800 });
  C.addEntry(state, { sessionId: session.id, category: 'TRIM', grams: 300 });
  C.closeSession(state, session.id, { returnedG: 880 });

  const r = C.reconcileSession(state, session.id);
  assert.equal(r.outputG, 1100);
  assert.equal(r.accountedG, 1980);
  assert.equal(r.varianceG, -20, '20 g of moisture loss');
  assert.equal(r.variancePct, -1);
  assert.equal(r.withinTolerance, true);

  // 10000 in - 2000 issued + 880 returned = 8880 still unprocessed.
  assert.equal(C.reconcileBatch(state, batch.id).onHandG, 8880);
});

test('variance outside tolerance is flagged', () => {
  const { state, session } = room({ issuedG: 1000 });
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 500 });
  C.closeSession(state, session.id, { returnedG: 400 });
  const r = C.reconcileSession(state, session.id);
  assert.equal(r.varianceG, -100);
  assert.equal(r.variancePct, -10);
  assert.equal(r.withinTolerance, false, '10% loss is a recording problem, not moisture');
});

test('tolerance is configurable per facility', () => {
  const { state, session } = room({ issuedG: 1000 });
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 960 });
  C.closeSession(state, session.id, { returnedG: 10 });
  assert.equal(C.reconcileSession(state, session.id).withinTolerance, false);
  state.settings.tolerancePct = 5;
  assert.equal(C.reconcileSession(state, session.id).withinTolerance, true);
});

test('a station cannot be issued more than the batch has left', () => {
  const { state, batch } = room({ intakeG: 1000, issuedG: 800 });
  throwsCode(() => C.openSession(state, { batchId: batch.id, trimmer: 'Bo', issuedG: 500 }), 'OVER_ISSUE');
  const ok = C.openSession(state, { batchId: batch.id, trimmer: 'Bo', issuedG: 200 });
  assert.equal(ok.issuedG, 200);
  assert.equal(C.reconcileBatch(state, batch.id).onHandG, 0);
});

test('stations need a trimmer on them', () => {
  const { state, batch } = room();
  throwsCode(() => C.openSession(state, { batchId: batch.id, trimmer: '', issuedG: 100 }), 'REQUIRED');
});

test('batch reconciliation balances intake against every stream', () => {
  const state = C.createState();
  const batch = C.openBatch(state, { tag: 'HL-2', strain: 'Gelato', intakeG: 4000 });
  ['Ana', 'Bo'].forEach((trimmer) => {
    const s = C.openSession(state, { batchId: batch.id, trimmer, issuedG: 2000 });
    C.addEntry(state, { sessionId: s.id, category: 'A', grams: 900 });
    C.addEntry(state, { sessionId: s.id, category: 'B', grams: 400 });
    C.addEntry(state, { sessionId: s.id, category: 'TRIM', grams: 500 });
    C.addEntry(state, { sessionId: s.id, category: 'WASTE', grams: 180, wasteReason: 'FAN' });
    C.closeSession(state, s.id, { returnedG: 0 });
  });

  const r = C.reconcileBatch(state, batch.id);
  assert.equal(r.issuedG, 4000);
  assert.equal(r.onHandG, 0);
  assert.equal(r.totals.A, 1800);
  assert.equal(r.totals.WASTE, 360);
  assert.equal(r.outputG, 3960);
  assert.equal(r.varianceG, -40);
  assert.equal(r.variancePct, -1);
  assert.equal(r.settled, true);
  assert.equal(r.aPct, 50, 'A buds are half the saleable product');
  assert.equal(r.wastePct, 9.09);
  // Batch variance is exactly the sum of its stations' variances.
  const stationVariance = C.sum(state.sessions.map((s) => C.reconcileSession(state, s.id).varianceG));
  assert.equal(r.varianceG, stationVariance);
});

test('an open station leaves the batch unsettled', () => {
  const { state, batch } = room();
  const r = C.reconcileBatch(state, batch.id);
  assert.equal(r.settled, false);
  assert.equal(r.openSessions, 1);
});

test('voided entries leave the totals but stay in the log', () => {
  const { state, session } = room();
  const entry = C.addEntry(state, { sessionId: session.id, category: 'A', grams: 1000 });
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 100 });
  assert.equal(C.sessionTotals(state, session.id).A, 1100);

  throwsCode(() => C.voidEntry(state, entry.id, {}), 'REQUIRED');
  C.voidEntry(state, entry.id, { reason: 'scale not tared', operator: 'Lead' });

  assert.equal(C.sessionTotals(state, session.id).A, 100, 'voided weight drops out of totals');
  assert.equal(state.entries.length, 2, 'nothing is deleted');
  assert.equal(C.filterEntries(state, { includeVoided: true }).length, 2);
  assert.equal(C.filterEntries(state, {}).length, 1);
  throwsCode(() => C.voidEntry(state, entry.id, { reason: 'again' }), 'VOIDED');
});

test('voiding frees the weight back up for re-entry', () => {
  const { state, session } = room({ issuedG: 1000 });
  const bad = C.addEntry(state, { sessionId: session.id, category: 'A', grams: 950 });
  throwsCode(() => C.addEntry(state, { sessionId: session.id, category: 'B', grams: 200 }), 'OVER_ISSUE');
  C.voidEntry(state, bad.id, { reason: 'typo' });
  const fixed = C.addEntry(state, { sessionId: session.id, category: 'A', grams: 95 });
  assert.equal(fixed.grams, 95);
});

test('a batch cannot close over an open station', () => {
  const { state, batch, session } = room();
  throwsCode(() => C.closeBatch(state, batch.id), 'OPEN_SESSIONS');
  C.closeSession(state, session.id, { returnedG: 2000 });
  const closed = C.closeBatch(state, batch.id);
  assert.equal(closed.status, 'closed');
  throwsCode(() => C.closeBatch(state, batch.id), 'CLOSED');
  throwsCode(() => C.openSession(state, { batchId: batch.id, trimmer: 'Bo', issuedG: 10 }), 'CLOSED');
});

test('trimmer stats rank throughput and quality', () => {
  const state = C.createState();
  const batch = C.openBatch(state, { tag: 'HL-3', strain: 'Runtz', intakeG: 10000 });
  const start = '2026-03-02T09:00:00.000Z';
  const end = '2026-03-02T11:00:00.000Z';

  const ana = C.openSession(state, { batchId: batch.id, trimmer: 'Ana', issuedG: 2000, at: start });
  C.addEntry(state, { sessionId: ana.id, category: 'A', grams: 1200, at: start });
  C.addEntry(state, { sessionId: ana.id, category: 'B', grams: 400, at: start });
  C.closeSession(state, ana.id, { returnedG: 380, at: end });

  const bo = C.openSession(state, { batchId: batch.id, trimmer: 'Bo', issuedG: 2000, at: start });
  C.addEntry(state, { sessionId: bo.id, category: 'A', grams: 400, at: start });
  C.addEntry(state, { sessionId: bo.id, category: 'B', grams: 400, at: start });
  C.closeSession(state, bo.id, { returnedG: 1180, at: end });

  const stats = C.trimmerStats(state);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].trimmer, 'Ana', 'sorted by weight processed');
  assert.equal(stats[0].minutes, 120);
  assert.equal(stats[0].gramsPerHour, 800);
  assert.equal(stats[0].aPct, 75);
  assert.equal(stats[1].gramsPerHour, 400);
  assert.equal(stats[1].aPct, 50);
});

test('a station that just opened reports no throughput yet', () => {
  const { state, session } = room();
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 500 });
  // Seconds of elapsed time would otherwise divide out to millions of g/hr.
  assert.equal(C.reconcileSession(state, session.id).gramsPerHour, 0);
  assert.equal(C.gramsPerHour(500, 0.05), 0);
  assert.equal(C.gramsPerHour(500, 60), 500);
  assert.equal(C.gramsPerHour(250, 30), 500);
});

test('waste log groups by day, batch and reason for the manifest', () => {
  const { state, session } = room();
  const at = '2026-03-02T18:00:00.000Z';
  C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 100, wasteReason: 'STEM', at });
  C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 50, wasteReason: 'STEM', at });
  C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 25, wasteReason: 'FAN', at });
  const voided = C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 999, wasteReason: 'FAN', at });
  C.voidEntry(state, voided.id, { reason: 'double weighed' });

  const log = C.wasteLog(state);
  assert.equal(log.length, 2);
  const stems = log.find((r) => r.reason === 'STEM');
  assert.equal(stems.grams, 150);
  assert.equal(stems.count, 2);
  assert.equal(stems.tag, 'HL-0001');
  assert.equal(log.find((r) => r.reason === 'FAN').grams, 25, 'voided waste is excluded');
});

test('entries filter by day, batch, trimmer and category', () => {
  const { state, batch, session } = room();
  const day1 = new Date(2026, 2, 2, 10).toISOString();
  const day2 = new Date(2026, 2, 3, 10).toISOString();
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 100, at: day1 });
  C.addEntry(state, { sessionId: session.id, category: 'B', grams: 100, at: day2 });

  assert.equal(C.filterEntries(state, { from: '2026-03-03' }).length, 1);
  assert.equal(C.filterEntries(state, { to: '2026-03-02' }).length, 1);
  assert.equal(C.filterEntries(state, { from: '2026-03-02', to: '2026-03-03' }).length, 2);
  assert.equal(C.filterEntries(state, { category: 'A' }).length, 1);
  assert.equal(C.filterEntries(state, { trimmer: 'Ana' }).length, 2);
  assert.equal(C.filterEntries(state, { trimmer: 'Nobody' }).length, 0);
  assert.equal(C.filterEntries(state, { batchId: batch.id }).length, 2);
});

test('room totals summarise what is running right now', () => {
  const { state, session } = room();
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 600 });
  C.addEntry(state, { sessionId: session.id, category: 'WASTE', grams: 200, wasteReason: 'STEM' });
  const room1 = C.roomTotals(state, {});
  assert.equal(room1.totals.A, 600);
  assert.equal(room1.openSessions, 1);
  assert.equal(room1.openBatches, 1);
  assert.equal(room1.wastePct, 25);
});

test('state survives a save and reload', () => {
  const { state, batch, session } = room();
  C.addEntry(state, { sessionId: session.id, category: 'A', grams: 500 });
  const reloaded = C.loadState(JSON.stringify(state));

  assert.equal(reloaded.batches.length, 1);
  assert.equal(reloaded.entries.length, 1);
  assert.equal(C.reconcileBatch(reloaded, batch.id).totals.A, 500);
  // Ids must keep counting up, never collide with what was restored.
  const next = C.addEntry(reloaded, { sessionId: session.id, category: 'B', grams: 10 });
  assert.equal(next.id, 'E-000002');
});

test('a corrupt or truncated backup is refused outright', () => {
  throwsCode(() => C.loadState('{not json'), 'PARSE');
  throwsCode(() => C.loadState('null'), 'PARSE');
  throwsCode(() => C.loadState(JSON.stringify({ batches: [], sessions: [] })), 'PARSE');
  throwsCode(
    () => C.loadState(JSON.stringify({ version: 99, batches: [], sessions: [], entries: [] })),
    'VERSION'
  );
});

test('sequence counters recover even if seq is lost', () => {
  const { state } = room();
  const raw = JSON.parse(JSON.stringify(state));
  delete raw.seq;
  const reloaded = C.loadState(raw);
  const batch = C.openBatch(reloaded, { tag: 'HL-NEW', strain: 'X', intakeG: 100 });
  assert.equal(batch.id, 'B-0002', 'does not reissue B-0001');
});
