const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/domain.js');
const R = require('../src/reports.js');

/** A finished day: one batch, two trimmers, all four streams, one void. */
function shift() {
  const state = C.createState();
  const at = new Date(2026, 2, 2, 9).toISOString();
  const end = new Date(2026, 2, 2, 17).toISOString();
  const batch = C.openBatch(state, { tag: 'HL-0001', strain: 'Blue Dream', intakeG: 6000, at });

  const ana = C.openSession(state, { batchId: batch.id, trimmer: 'Ana', station: '1', issuedG: 3000, at });
  C.addEntry(state, { sessionId: ana.id, category: 'A', grams: 1400, at });
  C.addEntry(state, { sessionId: ana.id, category: 'B', grams: 600, at });
  C.addEntry(state, { sessionId: ana.id, category: 'TRIM', grams: 700, at });
  C.addEntry(state, { sessionId: ana.id, category: 'WASTE', grams: 280, wasteReason: 'STEM', at });
  C.closeSession(state, ana.id, { returnedG: 0, at: end });

  const bo = C.openSession(state, { batchId: batch.id, trimmer: 'Bo, "Bear"', station: '2', issuedG: 3000, at });
  C.addEntry(state, { sessionId: bo.id, category: 'A', grams: 1000, at });
  C.addEntry(state, { sessionId: bo.id, category: 'WASTE', grams: 300, wasteReason: 'FAN', at });
  const scrapped = C.addEntry(state, { sessionId: bo.id, category: 'A', grams: 500, at });
  C.voidEntry(state, scrapped.id, { reason: 'weighed twice', operator: 'Lead', at });

  return { state, batch, ana, bo };
}

const rows = (csv) => csv.trim().split('\r\n');
const cells = (line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));

test('csv cells quote separators, quotes and newlines', () => {
  assert.equal(R.csvCell('plain'), 'plain');
  assert.equal(R.csvCell('a,b'), '"a,b"');
  assert.equal(R.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(R.csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(R.csvCell(null), '');
  assert.equal(R.csvCell(0), '0');
});

test('every export has a header row and one row per record', () => {
  const { state } = shift();
  assert.equal(rows(R.entriesCsv(state)).length, 1 + 7, 'header + 7 entries incl. the voided one');
  assert.equal(rows(R.sessionsCsv(state)).length, 1 + 2);
  assert.equal(rows(R.batchesCsv(state)).length, 1 + 1);
  assert.equal(rows(R.trimmersCsv(state)).length, 1 + 2);
  assert.equal(rows(R.wasteCsv(state)).length, 1 + 2, 'stems and fan leaf');
});

test('the audit export keeps voided entries and marks them', () => {
  const { state } = shift();
  const lines = rows(R.entriesCsv(state));
  const voided = lines.filter((line) => line.includes('VOID,'));
  assert.equal(voided.length, 1);
  assert.match(voided[0], /weighed twice/);
  assert.equal(lines.filter((line) => line.includes(',ACTIVE,')).length, 6);
});

test('a trimmer name with a comma survives the round trip', () => {
  const { state } = shift();
  const line = rows(R.sessionsCsv(state)).find((l) => l.includes('Bear'));
  assert.match(line, /"Bo, ""Bear"""/);
  assert.equal(cells(line)[4], '"Bo, ""Bear"""');
});

test('the batch export reconciles to the same numbers as the room', () => {
  const { state, batch } = shift();
  const r = C.reconcileBatch(state, batch.id);
  const line = cells(rows(R.batchesCsv(state))[1]);
  assert.equal(Number(line[7]), r.intakeG);
  assert.equal(Number(line[11]), r.totals.A, 'A buds column');
  assert.equal(Number(line[14]), r.totals.WASTE, 'waste column');
  assert.equal(Number(line[16]), r.varianceG);
});

test('out-of-tolerance batches and stations are flagged in the exports', () => {
  const state = C.createState();
  const at = new Date(2026, 2, 2, 9).toISOString();
  const batch = C.openBatch(state, { tag: 'HL-9', strain: 'Gelato', intakeG: 1000, at });
  const s = C.openSession(state, { batchId: batch.id, trimmer: 'Cy', issuedG: 1000, at });
  C.addEntry(state, { sessionId: s.id, category: 'A', grams: 500, at });
  C.closeSession(state, s.id, { returnedG: 300, at });
  C.closeBatch(state, batch.id, { at });

  assert.match(R.sessionsCsv(state), /OVER TOLERANCE/);
  assert.match(R.batchesCsv(state), /OVER TOLERANCE/);
});

test('the waste manifest converts to pounds for the state form', () => {
  const { state } = shift();
  const stems = rows(R.wasteCsv(state)).find((line) => line.includes('STEM'));
  const c = cells(stems);
  assert.equal(Number(c[5]), 280, 'grams');
  assert.equal(Number(c[6]), 0.62, 'pounds');
});

test('exports honour the date filter', () => {
  const { state } = shift();
  const later = new Date(2026, 2, 5, 9).toISOString();
  const nextLot = C.openBatch(state, { tag: 'HL-0002', strain: 'Gelato', intakeG: 500, at: later });
  const s = C.openSession(state, { batchId: nextLot.id, trimmer: 'Dee', issuedG: 100, at: later });
  C.addEntry(state, { sessionId: s.id, category: 'A', grams: 40, at: later });

  assert.equal(rows(R.entriesCsv(state, { from: '2026-03-05' })).length, 2);
  assert.equal(rows(R.sessionsCsv(state, { to: '2026-03-02' })).length, 3);
  assert.equal(rows(R.trimmersCsv(state, { from: '2026-03-05' })).length, 2);
});
