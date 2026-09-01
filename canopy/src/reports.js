/*
 * Canopy — CSV report builders.
 *
 * Every export is a flat CSV so it can be dropped into a state reporting
 * upload, a payroll sheet, or a spreadsheet without further massaging.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./domain.js') : root.Canopy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CanopyReports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Canopy) {
  'use strict';

  const { round2, dayKey, findBatch, findSession, categoryLabel, wasteReasonLabel } = Canopy;

  /** RFC 4180: quote anything with a comma, quote or newline; double inner quotes. */
  function csvCell(value) {
    const str = value == null ? '' : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function toCsv(headers, rows) {
    return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  const localTime = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE') : '');

  /** Full audit trail, voided entries included and marked. */
  function entriesCsv(state, filter = {}) {
    const entries = Canopy.filterEntries(state, Object.assign({ includeVoided: true }, filter));
    const rows = entries.map((entry) => {
      const batch = findBatch(state, entry.batchId) || {};
      const session = findSession(state, entry.sessionId) || {};
      return [
        entry.id,
        localTime(entry.at),
        dayKey(entry.at),
        batch.tag || entry.batchId,
        batch.strain || '',
        session.id || entry.sessionId,
        session.trimmer || '',
        session.station || '',
        entry.category,
        categoryLabel(entry.category),
        round2(entry.grams),
        entry.wasteReason ? wasteReasonLabel(entry.wasteReason) : '',
        entry.note,
        entry.operator,
        entry.voidedAt ? 'VOID' : 'ACTIVE',
        entry.voidReason,
        entry.voidedBy,
        localTime(entry.voidedAt),
      ];
    });
    return toCsv(
      [
        'Entry ID', 'Recorded at', 'Day', 'Batch tag', 'Strain', 'Station ID', 'Trimmer', 'Station',
        'Category', 'Category name', 'Grams', 'Waste reason', 'Note', 'Operator',
        'Status', 'Void reason', 'Voided by', 'Voided at',
      ],
      rows
    );
  }

  /** Per-station reconciliation: issued vs weighed out vs returned. */
  function sessionsCsv(state, filter = {}) {
    const rows = state.sessions
      .filter((session) => {
        const day = dayKey(session.startedAt);
        if (filter.from && day < filter.from) return false;
        if (filter.to && day > filter.to) return false;
        if (filter.batchId && session.batchId !== filter.batchId) return false;
        return true;
      })
      .map((session) => {
        const r = Canopy.reconcileSession(state, session.id);
        const batch = findBatch(state, session.batchId) || {};
        return [
          session.id,
          dayKey(session.startedAt),
          batch.tag || session.batchId,
          batch.strain || '',
          session.trimmer,
          session.station,
          localTime(session.startedAt),
          localTime(session.endedAt),
          r.minutes,
          r.issuedG,
          r.totals.A,
          r.totals.B,
          r.totals.TRIM,
          r.totals.WASTE,
          r.outputG,
          r.returnedG,
          r.varianceG,
          r.variancePct,
          r.aPct,
          r.wastePct,
          r.gramsPerHour,
          session.status,
          session.status === 'closed' && !r.withinTolerance ? 'OVER TOLERANCE' : '',
        ];
      });
    return toCsv(
      [
        'Station ID', 'Day', 'Batch tag', 'Strain', 'Trimmer', 'Station', 'Started', 'Ended', 'Minutes',
        'Issued g', 'A buds g', 'B buds g', 'Trim g', 'Waste g', 'Total out g', 'Returned g',
        'Variance g', 'Variance %', 'A %', 'Waste %', 'g/hr', 'Status', 'Flag',
      ],
      rows
    );
  }

  /** One row per batch — the sheet the room lead signs off on. */
  function batchesCsv(state) {
    const rows = state.batches.map((batch) => {
      const r = Canopy.reconcileBatch(state, batch.id);
      return [
        batch.id,
        batch.tag,
        batch.strain,
        batch.harvestDate,
        localTime(batch.openedAt),
        localTime(batch.closedAt),
        batch.status,
        r.intakeG,
        r.issuedG,
        r.returnedG,
        r.onHandG,
        r.totals.A,
        r.totals.B,
        r.totals.TRIM,
        r.totals.WASTE,
        r.outputG,
        r.varianceG,
        r.variancePct,
        r.aPct,
        r.bPct,
        r.trimPct,
        r.wastePct,
        r.sessionCount,
        r.settled && !r.withinTolerance ? 'OVER TOLERANCE' : '',
      ];
    });
    return toCsv(
      [
        'Batch ID', 'Batch tag', 'Strain', 'Harvest date', 'Opened', 'Closed', 'Status',
        'Intake g', 'Issued g', 'Returned g', 'Unprocessed on hand g',
        'A buds g', 'B buds g', 'Trim g', 'Waste g', 'Total out g',
        'Variance g', 'Variance %', 'A %', 'B %', 'Trim %', 'Waste %', 'Stations', 'Flag',
      ],
      rows
    );
  }

  /** Waste by day, batch and reason code — the destruction manifest. */
  function wasteCsv(state, filter = {}) {
    const rows = Canopy.wasteLog(state, filter).map((row) => [
      row.day,
      row.tag,
      row.strain,
      row.reason,
      row.reasonLabel,
      row.grams,
      round2(row.grams / Canopy.GRAMS_PER_LB),
      row.count,
    ]);
    return toCsv(['Day', 'Batch tag', 'Strain', 'Reason code', 'Reason', 'Grams', 'Pounds', 'Entries'], rows);
  }

  /** Throughput and quality mix per trimmer. */
  function trimmersCsv(state, filter = {}) {
    const rows = Canopy.trimmerStats(state, filter).map((row) => [
      row.trimmer,
      row.sessions,
      round2(row.minutes / 60),
      row.issuedG,
      row.A,
      row.B,
      row.TRIM,
      row.WASTE,
      row.output,
      row.gramsPerHour,
      row.aPct,
      row.wastePct,
    ]);
    return toCsv(
      [
        'Trimmer', 'Stations', 'Hours', 'Issued g', 'A buds g', 'B buds g', 'Trim g', 'Waste g',
        'Total out g', 'g/hr', 'A %', 'Waste %',
      ],
      rows
    );
  }

  function filenameStamp(date = new Date()) {
    return date.toLocaleDateString('sv-SE');
  }

  return { csvCell, toCsv, entriesCsv, sessionsCsv, batchesCsv, wasteCsv, trimmersCsv, filenameStamp };
});
