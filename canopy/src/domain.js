/*
 * Canopy — trim room inventory tracking.
 *
 * Domain model and reconciliation math for a trim room that breaks dried,
 * bucked material down into four streams: A buds, B buds, trim and waste.
 *
 * Loads unmodified in the browser (classic script -> window.Canopy) and in Node
 * (module.exports), so the UI and the tests run the same math.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Canopy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_VERSION = 1;

  const CATEGORIES = [
    { id: 'A', label: 'A buds', hint: 'Top shelf, jar-ready flower', key: 'a' },
    { id: 'B', label: 'B buds', hint: 'Smalls, popcorn, lower grade', key: 'b' },
    { id: 'TRIM', label: 'Trim', hint: 'Sugar leaf held for extraction', key: 't' },
    { id: 'WASTE', label: 'Waste', hint: 'Stems, fan leaf, unusable', key: 'w' },
  ];
  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
  const PRODUCT_IDS = ['A', 'B', 'TRIM'];

  // Waste needs a reason code on every entry — that is what the destruction
  // manifest is built from.
  const WASTE_REASONS = [
    { id: 'STEM', label: 'Stems' },
    { id: 'FAN', label: 'Fan leaf' },
    { id: 'FINES', label: 'Fines / dust' },
    { id: 'FLOOR', label: 'Floor waste' },
    { id: 'CONTAM', label: 'Contaminated / mold' },
    { id: 'OTHER', label: 'Other' },
  ];
  const WASTE_REASON_IDS = WASTE_REASONS.map((r) => r.id);

  const GRAMS_PER_LB = 453.59237;
  const GRAMS_PER_OZ = 28.349523125;
  const UNITS = { g: 1, oz: GRAMS_PER_OZ, lb: GRAMS_PER_LB };

  class CanopyError extends Error {
    constructor(message, code, meta) {
      super(message);
      this.name = 'CanopyError';
      this.code = code || 'INVALID';
      this.meta = meta || {};
    }
  }

  const fail = (code, message, meta) => {
    throw new CanopyError(message, code, meta);
  };

  /* ---------------------------------------------------------------- weights */

  /** Scales report to 0.01 g; round every result so sums don't drift. */
  function round2(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + (n >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
  }

  function toGrams(value, unit) {
    const factor = UNITS[unit || 'g'];
    if (!factor) fail('UNIT', `Unknown unit "${unit}"`);
    return round2(Number(value) * factor);
  }

  function fromGrams(grams, unit) {
    const factor = UNITS[unit || 'g'];
    if (!factor) fail('UNIT', `Unknown unit "${unit}"`);
    return round2(grams / factor);
  }

  function sum(values) {
    return round2(values.reduce((total, n) => total + (Number(n) || 0), 0));
  }

  /** Weights are always positive grams; reject typos and junk at the door. */
  function weight(value, field) {
    const grams = Number(value);
    if (!Number.isFinite(grams)) fail('WEIGHT', `${field} must be a number`);
    if (grams <= 0) fail('WEIGHT', `${field} must be greater than zero`);
    if (grams > 1e7) fail('WEIGHT', `${field} looks wrong (over 10,000 kg)`);
    return round2(grams);
  }

  function nonNegative(value, field) {
    const grams = Number(value);
    if (!Number.isFinite(grams) || grams < 0) fail('WEIGHT', `${field} cannot be negative`);
    return round2(grams);
  }

  function text(value, field, { required = false, max = 200 } = {}) {
    const str = String(value == null ? '' : value).trim();
    if (required && !str) fail('REQUIRED', `${field} is required`);
    return str.slice(0, max);
  }

  const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : 0);

  /* ------------------------------------------------------------------ state */

  function createState(overrides) {
    return Object.assign(
      {
        version: STATE_VERSION,
        settings: {
          facility: '',
          room: 'Trim Room',
          // Trimming dry material sheds a little moisture; anything past this
          // is a weighing or recording problem, not physics.
          tolerancePct: 2,
          defaultUnit: 'g',
        },
        batches: [],
        sessions: [],
        entries: [],
        seq: { batch: 0, session: 0, entry: 0 },
      },
      overrides || {}
    );
  }

  function nextId(state, kind, prefix, width) {
    state.seq[kind] = (state.seq[kind] || 0) + 1;
    return prefix + String(state.seq[kind]).padStart(width, '0');
  }

  const nowIso = () => new Date().toISOString();

  /** Local calendar day (YYYY-MM-DD) — shifts are worked in local time. */
  function dayKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const findBatch = (state, id) => state.batches.find((b) => b.id === id);
  const findSession = (state, id) => state.sessions.find((s) => s.id === id);
  const findEntry = (state, id) => state.entries.find((e) => e.id === id);

  function requireBatch(state, id) {
    const batch = findBatch(state, id);
    if (!batch) fail('NOT_FOUND', `Batch ${id} not found`);
    return batch;
  }

  function requireSession(state, id) {
    const session = findSession(state, id);
    if (!session) fail('NOT_FOUND', `Station ${id} not found`);
    return session;
  }

  /* --------------------------------------------------------------- commands */

  /** Weigh a lot of dried, bucked material into the room. */
  function openBatch(state, input) {
    const batch = {
      id: nextId(state, 'batch', 'B-', 4),
      tag: text(input.tag, 'Batch / package tag', { required: true }),
      strain: text(input.strain, 'Strain', { required: true }),
      harvestDate: text(input.harvestDate, 'Harvest date'),
      intakeG: weight(input.intakeG, 'Intake weight'),
      note: text(input.note, 'Note', { max: 500 }),
      openedAt: input.at || nowIso(),
      openedBy: text(input.operator, 'Operator'),
      closedAt: null,
      status: 'open',
    };
    if (state.batches.some((b) => b.tag.toLowerCase() === batch.tag.toLowerCase())) {
      fail('DUPLICATE', `Batch tag "${batch.tag}" is already in the room`);
    }
    state.batches.push(batch);
    return batch;
  }

  function closeBatch(state, batchId, input = {}) {
    const batch = requireBatch(state, batchId);
    if (batch.status === 'closed') fail('CLOSED', `Batch ${batch.tag} is already closed`);
    const open = openSessions(state).filter((s) => s.batchId === batchId);
    if (open.length) {
      fail('OPEN_SESSIONS', `Close ${open.length} open station(s) on ${batch.tag} first`, {
        sessions: open.map((s) => s.id),
      });
    }
    batch.status = 'closed';
    batch.closedAt = input.at || nowIso();
    batch.closedBy = text(input.operator, 'Operator');
    return batch;
  }

  /** Issue material from a batch to a trimmer's station. */
  function openSession(state, input) {
    const batch = requireBatch(state, input.batchId);
    if (batch.status === 'closed') fail('CLOSED', `Batch ${batch.tag} is closed`);

    const issuedG = weight(input.issuedG, 'Issued weight');
    const onHand = reconcileBatch(state, batch.id).onHandG;
    if (issuedG > onHand && !input.allowOverIssue) {
      fail('OVER_ISSUE', `Only ${onHand} g of ${batch.tag} is unprocessed in the room`, {
        requested: issuedG,
        available: onHand,
      });
    }

    const session = {
      id: nextId(state, 'session', 'S-', 4),
      batchId: batch.id,
      trimmer: text(input.trimmer, 'Trimmer', { required: true }),
      station: text(input.station, 'Station'),
      issuedG,
      returnedG: 0,
      startedAt: input.at || nowIso(),
      endedAt: null,
      status: 'open',
      note: text(input.note, 'Note', { max: 500 }),
    };
    state.sessions.push(session);
    return session;
  }

  /**
   * Close a station: whatever was issued but not trimmed is weighed back to the
   * batch, and the station's variance is locked in.
   */
  function closeSession(state, sessionId, input = {}) {
    const session = requireSession(state, sessionId);
    if (session.status === 'closed') fail('CLOSED', `Station ${session.id} is already closed`);

    const returnedG = nonNegative(input.returnedG || 0, 'Returned weight');
    const output = sessionTotals(state, session.id).output;
    if (output + returnedG > session.issuedG && !input.allowOverIssue) {
      fail(
        'OVER_ISSUE',
        `Weighed out ${round2(output + returnedG)} g against ${session.issuedG} g issued`,
        { issued: session.issuedG, accounted: round2(output + returnedG) }
      );
    }

    session.returnedG = returnedG;
    session.endedAt = input.at || nowIso();
    session.closedBy = text(input.operator, 'Operator');
    session.status = 'closed';
    return session;
  }

  /** Record one weigh-out from a station into one of the four streams. */
  function addEntry(state, input) {
    const session = requireSession(state, input.sessionId);
    if (session.status === 'closed') fail('CLOSED', `Station ${session.id} is closed`);

    const category = String(input.category || '').toUpperCase();
    if (!CATEGORY_IDS.includes(category)) fail('CATEGORY', `Unknown category "${input.category}"`);

    const grams = weight(input.grams, 'Weight');
    const note = text(input.note, 'Note', { max: 500 });

    let wasteReason = '';
    if (category === 'WASTE') {
      wasteReason = String(input.wasteReason || '').toUpperCase();
      if (!WASTE_REASON_IDS.includes(wasteReason)) {
        fail('WASTE_REASON', 'Waste needs a reason code');
      }
      if (wasteReason === 'OTHER' && !note) {
        fail('WASTE_REASON', 'Waste reason "Other" needs a note');
      }
    }

    const accounted = round2(sessionTotals(state, session.id).output + session.returnedG + grams);
    if (accounted > session.issuedG && !input.allowOverIssue) {
      fail('OVER_ISSUE', `That puts ${session.id} ${round2(accounted - session.issuedG)} g over what was issued`, {
        issued: session.issuedG,
        accounted,
        over: round2(accounted - session.issuedG),
      });
    }

    const entry = {
      id: nextId(state, 'entry', 'E-', 6),
      sessionId: session.id,
      batchId: session.batchId,
      category,
      grams,
      wasteReason,
      note,
      at: input.at || nowIso(),
      operator: text(input.operator, 'Operator') || session.trimmer,
      voidedAt: null,
      voidedBy: '',
      voidReason: '',
    };
    state.entries.push(entry);
    return entry;
  }

  /**
   * Entries are append-only: a mistake is voided with a reason and stays in the
   * log. Totals skip voided entries; the audit trail keeps them.
   */
  function voidEntry(state, entryId, input = {}) {
    const entry = findEntry(state, entryId);
    if (!entry) fail('NOT_FOUND', `Entry ${entryId} not found`);
    if (entry.voidedAt) fail('VOIDED', `Entry ${entry.id} is already voided`);
    entry.voidReason = text(input.reason, 'Void reason', { required: true });
    entry.voidedAt = input.at || nowIso();
    entry.voidedBy = text(input.operator, 'Operator');
    return entry;
  }

  /* -------------------------------------------------------------- selectors */

  const openSessions = (state) => state.sessions.filter((s) => s.status === 'open');
  const openBatches = (state) => state.batches.filter((b) => b.status === 'open');

  function liveEntries(state) {
    return state.entries.filter((e) => !e.voidedAt);
  }

  function emptyTotals() {
    const totals = { count: 0, product: 0, output: 0 };
    CATEGORY_IDS.forEach((id) => {
      totals[id] = 0;
    });
    return totals;
  }

  function tally(entries) {
    const totals = emptyTotals();
    entries.forEach((entry) => {
      if (entry.voidedAt) return;
      totals[entry.category] = round2(totals[entry.category] + entry.grams);
      totals.count += 1;
    });
    totals.product = sum(PRODUCT_IDS.map((id) => totals[id]));
    totals.output = round2(totals.product + totals.WASTE);
    return totals;
  }

  function sessionTotals(state, sessionId) {
    return tally(state.entries.filter((e) => e.sessionId === sessionId));
  }

  function batchTotals(state, batchId) {
    return tally(state.entries.filter((e) => e.batchId === batchId));
  }

  /**
   * Station reconciliation. `remainingG` is what should still be on the table
   * while the station is open; `variance` is the loss once it is closed.
   */
  function reconcileSession(state, sessionId) {
    const session = requireSession(state, sessionId);
    const totals = sessionTotals(state, session.id);
    const accounted = round2(totals.output + session.returnedG);
    const variance = round2(accounted - session.issuedG);
    const variancePct = pct(variance, session.issuedG);
    const tolerance = state.settings.tolerancePct;
    return {
      session,
      totals,
      issuedG: session.issuedG,
      returnedG: session.returnedG,
      outputG: totals.output,
      accountedG: accounted,
      remainingG: round2(session.issuedG - accounted),
      varianceG: variance,
      variancePct,
      withinTolerance: Math.abs(variancePct) <= tolerance,
      aPct: pct(totals.A, totals.product),
      wastePct: pct(totals.WASTE, totals.output),
      minutes: sessionMinutes(session),
      gramsPerHour: gramsPerHour(totals.output, sessionMinutes(session)),
    };
  }

  function sessionMinutes(session) {
    const end = session.endedAt ? new Date(session.endedAt) : new Date();
    const start = new Date(session.startedAt);
    const minutes = (end.getTime() - start.getTime()) / 60000;
    return minutes > 0 ? round2(minutes) : 0;
  }

  /**
   * Throughput needs elapsed time behind it: a station opened seconds ago would
   * otherwise report millions of grams an hour. Under a minute, report nothing.
   */
  function gramsPerHour(grams, minutes) {
    return minutes >= 1 ? round2(grams / (minutes / 60)) : 0;
  }

  /**
   * Batch reconciliation. Everything that came in is either weighed out, still
   * on the table, or unaccounted for:
   *   onHand   = intake - issued + returned
   *   variance = (output + onHand) - intake
   */
  function reconcileBatch(state, batchId) {
    const batch = requireBatch(state, batchId);
    const sessions = state.sessions.filter((s) => s.batchId === batch.id);
    const issuedG = sum(sessions.map((s) => s.issuedG));
    const returnedG = sum(sessions.map((s) => s.returnedG));
    const totals = batchTotals(state, batch.id);
    const onHandG = round2(batch.intakeG - issuedG + returnedG);
    const accountedG = round2(totals.output + onHandG);
    const varianceG = round2(accountedG - batch.intakeG);
    const variancePct = pct(varianceG, batch.intakeG);
    const openCount = sessions.filter((s) => s.status === 'open').length;
    return {
      batch,
      totals,
      intakeG: batch.intakeG,
      issuedG,
      returnedG,
      onHandG,
      outputG: totals.output,
      accountedG,
      varianceG,
      variancePct,
      // Variance only means something once every station has weighed back in.
      withinTolerance: Math.abs(variancePct) <= state.settings.tolerancePct,
      settled: openCount === 0,
      openSessions: openCount,
      sessionCount: sessions.length,
      aPct: pct(totals.A, totals.product),
      bPct: pct(totals.B, totals.product),
      trimPct: pct(totals.TRIM, totals.product),
      wastePct: pct(totals.WASTE, totals.output),
    };
  }

  /** Room-wide totals across every open batch, for the header strip. */
  function roomTotals(state, filter) {
    const entries = filterEntries(state, filter);
    const totals = tally(entries);
    return {
      totals,
      openSessions: openSessions(state).length,
      openBatches: openBatches(state).length,
      aPct: pct(totals.A, totals.product),
      wastePct: pct(totals.WASTE, totals.output),
    };
  }

  function filterEntries(state, filter = {}) {
    return state.entries.filter((entry) => {
      if (!filter.includeVoided && entry.voidedAt) return false;
      if (filter.batchId && entry.batchId !== filter.batchId) return false;
      if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
      if (filter.category && entry.category !== filter.category) return false;
      if (filter.trimmer) {
        const session = findSession(state, entry.sessionId);
        if (!session || session.trimmer !== filter.trimmer) return false;
      }
      const day = dayKey(entry.at);
      if (filter.from && day < filter.from) return false;
      if (filter.to && day > filter.to) return false;
      return true;
    });
  }

  /** Per-trimmer throughput and quality mix, for payroll and coaching. */
  function trimmerStats(state, filter = {}) {
    const byTrimmer = new Map();
    state.sessions.forEach((session) => {
      const day = dayKey(session.startedAt);
      if (filter.from && day < filter.from) return;
      if (filter.to && day > filter.to) return;
      if (filter.batchId && session.batchId !== filter.batchId) return;

      const row =
        byTrimmer.get(session.trimmer) ||
        Object.assign({ trimmer: session.trimmer, sessions: 0, minutes: 0, issuedG: 0 }, emptyTotals());
      const totals = sessionTotals(state, session.id);
      row.sessions += 1;
      row.minutes = round2(row.minutes + sessionMinutes(session));
      row.issuedG = round2(row.issuedG + session.issuedG);
      CATEGORY_IDS.forEach((id) => {
        row[id] = round2(row[id] + totals[id]);
      });
      row.count += totals.count;
      byTrimmer.set(session.trimmer, row);
    });

    return [...byTrimmer.values()]
      .map((row) => {
        row.product = sum(PRODUCT_IDS.map((id) => row[id]));
        row.output = round2(row.product + row.WASTE);
        row.gramsPerHour = gramsPerHour(row.output, row.minutes);
        row.aPct = pct(row.A, row.product);
        row.wastePct = pct(row.WASTE, row.output);
        return row;
      })
      .sort((a, b) => b.output - a.output);
  }

  /** Waste ready for the destruction manifest, grouped by day and reason. */
  function wasteLog(state, filter = {}) {
    const rows = new Map();
    filterEntries(state, Object.assign({}, filter, { category: 'WASTE' })).forEach((entry) => {
      const batch = findBatch(state, entry.batchId);
      const day = dayKey(entry.at);
      const key = `${day}|${entry.batchId}|${entry.wasteReason}`;
      const row =
        rows.get(key) ||
        {
          day,
          batchId: entry.batchId,
          tag: batch ? batch.tag : entry.batchId,
          strain: batch ? batch.strain : '',
          reason: entry.wasteReason,
          reasonLabel: wasteReasonLabel(entry.wasteReason),
          grams: 0,
          count: 0,
        };
      row.grams = round2(row.grams + entry.grams);
      row.count += 1;
      rows.set(key, row);
    });
    return [...rows.values()].sort((a, b) => (a.day === b.day ? a.tag.localeCompare(b.tag) : b.day.localeCompare(a.day)));
  }

  const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || {}).label || id;
  const wasteReasonLabel = (id) => (WASTE_REASONS.find((r) => r.id === id) || {}).label || id;

  /* ----------------------------------------------------------- persistence */

  /**
   * Rebuild state from stored JSON. Anything unparseable is rejected outright
   * rather than half-loaded — a partial inventory is worse than none.
   */
  function loadState(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        fail('PARSE', 'Saved data is not valid JSON');
      }
    }
    if (!data || typeof data !== 'object') fail('PARSE', 'Saved data is not a Canopy backup');
    if (!Array.isArray(data.batches) || !Array.isArray(data.sessions) || !Array.isArray(data.entries)) {
      fail('PARSE', 'Saved data is missing batches, stations or entries');
    }
    if (data.version > STATE_VERSION) {
      fail('VERSION', `Backup was written by a newer version (v${data.version})`);
    }

    const state = createState();
    state.settings = Object.assign(state.settings, data.settings || {});
    state.batches = data.batches;
    state.sessions = data.sessions;
    state.entries = data.entries;
    state.seq = Object.assign(state.seq, data.seq || {});

    // Sequence counters must never hand out an id that already exists.
    const highest = (items, prefix) =>
      items.reduce((max, item) => {
        const n = parseInt(String(item.id || '').replace(prefix, ''), 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
    state.seq.batch = Math.max(state.seq.batch, highest(state.batches, 'B-'));
    state.seq.session = Math.max(state.seq.session, highest(state.sessions, 'S-'));
    state.seq.entry = Math.max(state.seq.entry, highest(state.entries, 'E-'));
    return state;
  }

  return {
    STATE_VERSION,
    CATEGORIES,
    CATEGORY_IDS,
    PRODUCT_IDS,
    WASTE_REASONS,
    WASTE_REASON_IDS,
    UNITS,
    GRAMS_PER_LB,
    GRAMS_PER_OZ,
    CanopyError,
    round2,
    sum,
    pct,
    toGrams,
    fromGrams,
    dayKey,
    createState,
    loadState,
    openBatch,
    closeBatch,
    openSession,
    closeSession,
    addEntry,
    voidEntry,
    findBatch,
    findSession,
    findEntry,
    openBatches,
    openSessions,
    liveEntries,
    filterEntries,
    sessionTotals,
    batchTotals,
    sessionMinutes,
    gramsPerHour,
    reconcileSession,
    reconcileBatch,
    roomTotals,
    trimmerStats,
    wasteLog,
    categoryLabel,
    wasteReasonLabel,
  };
});
