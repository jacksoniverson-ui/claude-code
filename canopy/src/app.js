/*
 * Canopy — trim room UI.
 *
 * Holds the whole room in one state object, persists it to localStorage on
 * every change, and re-renders the active view. All weights are stored in
 * grams; the unit selectors only affect what the operator types.
 */
(function () {
  'use strict';

  const C = window.Canopy;
  const R = window.CanopyReports;
  const STORAGE_KEY = 'canopy.trimroom.v1';

  let state = null;
  let storageOk = true;
  const ui = { view: 'room', sessionId: null, category: null, batchId: null, range: 'all', from: '', to: '' };

  /* ----------------------------------------------------------- utilities */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);

  const g = (grams) => nf.format(C.round2(grams || 0)) + ' g';
  const num = (n) => nf.format(C.round2(n || 0));
  const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const dateTimeOf = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const todayKey = () => C.dayKey(new Date().toISOString());

  let toastTimer = null;
  function toast(message, bad) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, bad ? 5200 : 2600);
  }

  /**
   * Run a mutation. An over-issue block is the one error worth offering an
   * override for — everything else is a hard stop with the reason shown.
   */
  function run(action) {
    try {
      return action(false);
    } catch (err) {
      if (err && err.code === 'OVER_ISSUE') {
        const ask = `${err.message}.\n\nRecord it anyway? The variance will be flagged in the reports.`;
        if (window.confirm(ask)) {
          try {
            return action(true);
          } catch (retryErr) {
            toast(retryErr.message, true);
            return null;
          }
        }
        return null;
      }
      toast((err && err.message) || String(err), true);
      return null;
    }
  }

  /* --------------------------------------------------------- persistence */

  function boot() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      storageOk = false;
    }
    if (!raw) {
      state = C.createState();
      return;
    }
    try {
      state = C.loadState(raw);
    } catch (err) {
      // Never overwrite data we failed to parse — park it and start clean.
      try {
        window.localStorage.setItem(`${STORAGE_KEY}.unreadable.${Date.now()}`, raw);
      } catch (ignored) { /* nothing else we can do */ }
      state = C.createState();
      setTimeout(() => toast(`Saved data could not be read (${err.message}). A copy was kept in this browser.`, true), 300);
    }
  }

  function save() {
    if (!storageOk) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      storageOk = false;
      $('#storageWarning').hidden = false;
      toast('This browser will not save data — export a backup now.', true);
    }
  }

  function commit() {
    save();
    render();
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    $('#roomName').textContent = [state.settings.facility, state.settings.room].filter(Boolean).join(' · ') || 'Trim Room';
    $('#storageWarning').hidden = storageOk;
    renderStrip();
    if (ui.view === 'room') renderRoom();
    if (ui.view === 'batches') renderBatches();
    if (ui.view === 'reports') renderReports();
    if (ui.view === 'log') renderLog();
  }

  function renderStrip() {
    const today = todayKey();
    const room = C.roomTotals(state, { from: today, to: today });
    const cells = C.CATEGORIES.map(
      (cat) => `<div class="cell ${cat.id}"><b>${g(room.totals[cat.id])}</b><span>${esc(cat.label)} today</span></div>`
    );
    cells.push(`<div class="cell"><b>${room.openSessions}</b><span>stations open</span></div>`);
    cells.push(`<div class="cell"><b>${room.openBatches}</b><span>batches open</span></div>`);
    $('#roomStrip').innerHTML = cells.join('');
  }

  /* ----------------------------------------------------------- room view */

  function renderRoom() {
    const open = C.openSessions(state);
    if (ui.sessionId && !open.some((s) => s.id === ui.sessionId)) ui.sessionId = null;
    if (!ui.sessionId && open.length === 1) ui.sessionId = open[0].id;

    $('#stationList').innerHTML = open.length
      ? open.map(stationCard).join('')
      : `<div class="empty">No stations running.<br>Weigh in a batch, then open a station to start trimming.</div>`;

    renderPad();
  }

  function stationCard(session) {
    const r = C.reconcileSession(state, session.id);
    const batch = C.findBatch(state, session.batchId) || {};
    const width = (grams) => `${Math.max(0, Math.min(100, (grams / session.issuedG) * 100))}%`;
    const bars = C.CATEGORY_IDS.filter((id) => r.totals[id] > 0)
      .map((id) => `<i class="${id}" style="width:${width(r.totals[id])}" title="${esc(C.categoryLabel(id))} ${g(r.totals[id])}"></i>`)
      .join('');

    return `
      <article class="station ${session.id === ui.sessionId ? 'selected' : ''}" data-station="${session.id}">
        <div class="who"><b>${esc(session.trimmer)}</b><span>${session.station ? esc(session.station) + ' · ' : ''}${session.id}</span></div>
        <p class="lot">${esc(batch.tag || session.batchId)} · ${esc(batch.strain || '')} · started ${timeOf(session.startedAt)}</p>
        <div class="bar">${bars}</div>
        <div class="numbers">
          <div><span class="muted">Issued</span><b>${g(r.issuedG)}</b></div>
          <div><span class="muted">A / B</span><b>${num(r.totals.A)} / ${num(r.totals.B)}</b></div>
          <div><span class="muted">Trim / waste</span><b>${num(r.totals.TRIM)} / ${num(r.totals.WASTE)}</b></div>
          <div><span class="muted">Left on table</span><b>${g(r.remainingG)}</b></div>
          <div><span class="muted">Rate</span><b>${r.gramsPerHour ? num(r.gramsPerHour) + ' g/hr' : '—'}</b></div>
        </div>
        <div class="actions">
          <button data-select="${session.id}" class="primary">Weigh out</button>
          <button data-close-station="${session.id}">Close station</button>
        </div>
      </article>`;
  }

  function renderPad() {
    const session = ui.sessionId ? C.findSession(state, ui.sessionId) : null;
    const batch = session ? C.findBatch(state, session.batchId) : null;

    $('#padStation').textContent = session
      ? `${session.trimmer} · ${batch ? batch.tag : ''}`
      : 'No station selected';

    $('#padCats').innerHTML = C.CATEGORIES.map(
      (cat) => `<button data-cat="${cat.id}" class="${ui.category === cat.id ? 'on' : ''}">
          ${esc(cat.label)}<small>${esc(cat.hint)}</small>
        </button>`
    ).join('');

    $('#padWasteWrap').hidden = ui.category !== 'WASTE';
    $('#padSubmit').disabled = !session || !ui.category;
    $('#padSubmit').textContent = session && ui.category ? `Record ${C.categoryLabel(ui.category)}` : 'Record weigh-out';
    $$('#pad input, #pad select').forEach((el) => { el.disabled = !session; });
    $('#padWasteReason').disabled = !session;

    const recent = session
      ? state.entries.filter((e) => e.sessionId === session.id).slice(-6).reverse()
      : [];
    $('#padRecent').innerHTML = recent.length
      ? recent.map(
          (entry) => `<div class="row">
            <span class="tag ${entry.category}">${entry.category}</span>
            <b>${entry.voidedAt ? `<s>${g(entry.grams)}</s>` : g(entry.grams)}</b>
            ${entry.wasteReason ? `<span class="pill">${esc(C.wasteReasonLabel(entry.wasteReason))}</span>` : ''}
            <span class="when">${timeOf(entry.at)}</span>
            ${entry.voidedAt ? '' : `<button class="link" data-void="${entry.id}">void</button>`}
          </div>`
        ).join('')
      : `<p class="hint">Nothing recorded at this station yet.</p>`;
  }

  function selectCategory(id) {
    ui.category = ui.category === id ? null : id;
    renderPad();
    if (ui.category) $('#padWeight').focus();
  }

  function submitEntry() {
    const session = ui.sessionId && C.findSession(state, ui.sessionId);
    if (!session || !ui.category) return;
    const value = parseFloat($('#padWeight').value);
    if (!Number.isFinite(value) || value <= 0) {
      toast('Enter a weight first', true);
      $('#padWeight').focus();
      return;
    }

    const grams = C.toGrams(value, $('#padUnit').value);
    const entry = run((allowOverIssue) =>
      C.addEntry(state, {
        sessionId: session.id,
        category: ui.category,
        grams,
        wasteReason: $('#padWasteReason').value,
        note: $('#padNote').value,
        allowOverIssue,
      })
    );
    if (!entry) return;

    $('#padWeight').value = '';
    $('#padNote').value = '';
    commit();
    toast(`${g(entry.grams)} ${C.categoryLabel(entry.category).toLowerCase()} · ${session.trimmer}`);
    $('#padWeight').focus();
  }

  /* -------------------------------------------------------- batches view */

  function renderBatches() {
    if (!state.batches.length) {
      $('#batchTable').innerHTML = `<div class="empty">No batches yet. Weigh one in to start the room.</div>`;
      $('#batchDetail').innerHTML = '';
      return;
    }

    const rows = [...state.batches].reverse().map((batch) => {
      const r = C.reconcileBatch(state, batch.id);
      const flagged = r.settled && !r.withinTolerance;
      return `<tr data-batch="${batch.id}" class="${ui.batchId === batch.id ? 'selected' : ''}">
        <td><b>${esc(batch.tag)}</b></td>
        <td>${esc(batch.strain)}</td>
        <td><span class="pill">${batch.status}</span></td>
        <td class="num">${num(r.intakeG)}</td>
        <td class="num">${num(r.onHandG)}</td>
        <td class="num">${num(r.totals.A)}</td>
        <td class="num">${num(r.totals.B)}</td>
        <td class="num">${num(r.totals.TRIM)}</td>
        <td class="num">${num(r.totals.WASTE)}</td>
        <td class="num">${r.totals.product ? num(r.aPct) + '%' : '—'}</td>
        <td class="num ${flagged ? 'flag' : ''}">${r.settled ? num(r.varianceG) : '—'}</td>
        <td class="num ${flagged ? 'flag' : ''}">${r.settled ? num(r.variancePct) + '%' : '—'}</td>
        <td>${flagged ? '<span class="flag">over tolerance</span>' : r.settled ? '<span class="ok">balanced</span>' : `${r.openSessions} open`}</td>
        <td>${batch.status === 'open' ? `<button data-close-batch="${batch.id}">Close</button>` : ''}</td>
      </tr>`;
    });

    $('#batchTable').innerHTML = `<table>
      <thead><tr>
        <th>Tag</th><th>Strain</th><th>Status</th>
        <th class="num">Intake g</th><th class="num">On hand g</th>
        <th class="num">A</th><th class="num">B</th><th class="num">Trim</th><th class="num">Waste</th>
        <th class="num">A %</th><th class="num">Var g</th><th class="num">Var %</th><th>State</th><th></th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;

    renderBatchDetail();
  }

  function renderBatchDetail() {
    const batch = ui.batchId && C.findBatch(state, ui.batchId);
    if (!batch) {
      $('#batchDetail').innerHTML = '';
      return;
    }
    const sessions = state.sessions.filter((s) => s.batchId === batch.id);
    const rows = sessions.map((session) => {
      const r = C.reconcileSession(state, session.id);
      const flagged = session.status === 'closed' && !r.withinTolerance;
      return `<tr>
        <td>${session.id}</td>
        <td>${esc(session.trimmer)}</td>
        <td>${esc(session.station)}</td>
        <td>${timeOf(session.startedAt)}–${session.endedAt ? timeOf(session.endedAt) : '…'}</td>
        <td class="num">${num(r.issuedG)}</td>
        <td class="num">${num(r.totals.A)}</td>
        <td class="num">${num(r.totals.B)}</td>
        <td class="num">${num(r.totals.TRIM)}</td>
        <td class="num">${num(r.totals.WASTE)}</td>
        <td class="num">${num(r.returnedG)}</td>
        <td class="num ${flagged ? 'flag' : ''}">${session.status === 'closed' ? num(r.varianceG) : '—'}</td>
        <td class="num">${num(r.gramsPerHour)}</td>
        <td><span class="pill">${session.status}</span></td>
      </tr>`;
    });

    $('#batchDetail').innerHTML = `<h3>${esc(batch.tag)} — stations</h3>
      ${sessions.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>ID</th><th>Trimmer</th><th>Station</th><th>Time</th>
            <th class="num">Issued</th><th class="num">A</th><th class="num">B</th><th class="num">Trim</th>
            <th class="num">Waste</th><th class="num">Returned</th><th class="num">Var g</th><th class="num">g/hr</th><th>Status</th></tr></thead>
            <tbody>${rows.join('')}</tbody></table></div>`
        : `<div class="empty">No stations have run on this batch.</div>`}`;
  }

  /* -------------------------------------------------------- reports view */

  function reportFilter() {
    return { from: ui.from || undefined, to: ui.to || undefined };
  }

  function renderReports() {
    const filter = reportFilter();
    const totals = C.roomTotals(state, filter).totals;
    const tiles = C.CATEGORIES.map(
      (cat) => `<div class="tile ${cat.id}"><b>${g(totals[cat.id])}</b><span>${esc(cat.label)}</span></div>`
    );
    tiles.push(`<div class="tile"><b>${g(totals.product)}</b><span>Saleable product</span></div>`);
    tiles.push(`<div class="tile"><b>${num(C.pct(totals.A, totals.product))}%</b><span>A of product</span></div>`);
    tiles.push(`<div class="tile"><b>${num(C.pct(totals.WASTE, totals.output))}%</b><span>Waste of total out</span></div>`);
    $('#repTiles').innerHTML = tiles.join('');

    const trimmers = C.trimmerStats(state, filter);
    $('#repTrimmers').innerHTML = trimmers.length
      ? `<table><thead><tr><th>Trimmer</th><th class="num">Stations</th><th class="num">Hours</th>
          <th class="num">A</th><th class="num">B</th><th class="num">Trim</th><th class="num">Waste</th>
          <th class="num">Total out</th><th class="num">g/hr</th><th class="num">A %</th><th class="num">Waste %</th></tr></thead>
        <tbody>${trimmers.map((row) => `<tr>
          <td><b>${esc(row.trimmer)}</b></td>
          <td class="num">${row.sessions}</td>
          <td class="num">${num(row.minutes / 60)}</td>
          <td class="num">${num(row.A)}</td>
          <td class="num">${num(row.B)}</td>
          <td class="num">${num(row.TRIM)}</td>
          <td class="num">${num(row.WASTE)}</td>
          <td class="num">${num(row.output)}</td>
          <td class="num"><b>${num(row.gramsPerHour)}</b></td>
          <td class="num">${num(row.aPct)}%</td>
          <td class="num">${num(row.wastePct)}%</td>
        </tr>`).join('')}</tbody></table>`
      : `<div class="empty">Nothing recorded in this range.</div>`;

    const batches = state.batches.filter((batch) => {
      const day = C.dayKey(batch.openedAt);
      if (ui.from && day < ui.from) return false;
      if (ui.to && day > ui.to) return false;
      return true;
    });
    $('#repBatches').innerHTML = batches.length
      ? `<table><thead><tr><th>Tag</th><th>Strain</th><th class="num">Intake</th><th class="num">A</th>
          <th class="num">B</th><th class="num">Trim</th><th class="num">Waste</th>
          <th class="num">A %</th><th class="num">Waste %</th><th class="num">Var %</th><th>State</th></tr></thead>
        <tbody>${batches.map((batch) => {
          const r = C.reconcileBatch(state, batch.id);
          const flagged = r.settled && !r.withinTolerance;
          return `<tr>
            <td><b>${esc(batch.tag)}</b></td>
            <td>${esc(batch.strain)}</td>
            <td class="num">${num(r.intakeG)}</td>
            <td class="num">${num(r.totals.A)}</td>
            <td class="num">${num(r.totals.B)}</td>
            <td class="num">${num(r.totals.TRIM)}</td>
            <td class="num">${num(r.totals.WASTE)}</td>
            <td class="num">${num(r.aPct)}%</td>
            <td class="num">${num(r.wastePct)}%</td>
            <td class="num ${flagged ? 'flag' : ''}">${r.settled ? num(r.variancePct) + '%' : '—'}</td>
            <td>${flagged ? '<span class="flag">over tolerance</span>' : r.settled ? '<span class="ok">balanced</span>' : 'in progress'}</td>
          </tr>`;
        }).join('')}</tbody></table>`
      : `<div class="empty">No batches opened in this range.</div>`;

    const waste = C.wasteLog(state, filter);
    $('#repWaste').innerHTML = waste.length
      ? `<table><thead><tr><th>Day</th><th>Batch</th><th>Strain</th><th>Reason</th>
          <th class="num">Grams</th><th class="num">Pounds</th><th class="num">Entries</th></tr></thead>
        <tbody>${waste.map((row) => `<tr>
          <td>${row.day}</td>
          <td>${esc(row.tag)}</td>
          <td>${esc(row.strain)}</td>
          <td>${esc(row.reasonLabel)}</td>
          <td class="num">${num(row.grams)}</td>
          <td class="num">${num(row.grams / C.GRAMS_PER_LB)}</td>
          <td class="num">${row.count}</td>
        </tr>`).join('')}</tbody></table>`
      : `<div class="empty">No waste recorded in this range.</div>`;
  }

  function setRange(range) {
    ui.range = range;
    const today = todayKey();
    if (range === 'all') {
      ui.from = '';
      ui.to = '';
    } else if (range === 'today') {
      ui.from = today;
      ui.to = today;
    } else {
      const from = new Date();
      from.setDate(from.getDate() - (Number(range) - 1));
      ui.from = C.dayKey(from.toISOString());
      ui.to = today;
    }
    $('#repFrom').value = ui.from;
    $('#repTo').value = ui.to;
    $$('.range button').forEach((btn) => btn.classList.toggle('active', btn.dataset.range === range));
    renderReports();
  }

  /* ------------------------------------------------------------- log view */

  function renderLog() {
    const options = (values, selected) =>
      values.map((v) => `<option value="${esc(v.value)}" ${v.value === selected ? 'selected' : ''}>${esc(v.label)}</option>`).join('');

    const batchSel = $('#logBatch');
    const keepBatch = batchSel.value;
    batchSel.innerHTML = `<option value="">All batches</option>` +
      options(state.batches.map((b) => ({ value: b.id, label: `${b.tag} · ${b.strain}` })), keepBatch);
    batchSel.value = keepBatch;

    const catSel = $('#logCategory');
    const keepCat = catSel.value;
    catSel.innerHTML = `<option value="">All streams</option>` +
      options(C.CATEGORIES.map((c) => ({ value: c.id, label: c.label })), keepCat);
    catSel.value = keepCat;

    const trimmers = [...new Set(state.sessions.map((s) => s.trimmer))].sort();
    const trimSel = $('#logTrimmer');
    const keepTrim = trimSel.value;
    trimSel.innerHTML = `<option value="">All trimmers</option>` + options(trimmers.map((t) => ({ value: t, label: t })), keepTrim);
    trimSel.value = keepTrim;

    const entries = C.filterEntries(state, {
      includeVoided: $('#logVoided').checked,
      batchId: batchSel.value || undefined,
      category: catSel.value || undefined,
      trimmer: trimSel.value || undefined,
    }).slice().reverse();

    const shown = entries.slice(0, 300);
    $('#logTable').innerHTML = shown.length
      ? `<table><thead><tr><th>Entry</th><th>Time</th><th>Batch</th><th>Trimmer</th><th>Stream</th>
          <th class="num">Grams</th><th>Waste reason</th><th>Note</th><th>Status</th><th></th></tr></thead>
        <tbody>${shown.map((entry) => {
          const batch = C.findBatch(state, entry.batchId) || {};
          const session = C.findSession(state, entry.sessionId) || {};
          return `<tr>
            <td>${entry.id}</td>
            <td>${dateTimeOf(entry.at)}</td>
            <td>${esc(batch.tag || entry.batchId)}</td>
            <td>${esc(session.trimmer || '')}</td>
            <td><span class="tag pill">${esc(C.categoryLabel(entry.category))}</span></td>
            <td class="num ${entry.voidedAt ? 'void' : ''}">${num(entry.grams)}</td>
            <td>${entry.wasteReason ? esc(C.wasteReasonLabel(entry.wasteReason)) : ''}</td>
            <td>${esc(entry.note)}</td>
            <td>${entry.voidedAt ? `<span class="flag">void</span> ${esc(entry.voidReason)}` : ''}</td>
            <td>${entry.voidedAt || session.status === 'closed' ? '' : `<button class="link" data-void="${entry.id}">void</button>`}</td>
          </tr>`;
        }).join('')}</tbody></table>
        ${entries.length > shown.length ? `<p class="hint" style="padding:8px 12px">Showing the latest 300 of ${entries.length} entries. Export the audit CSV for the full log.</p>` : ''}`
      : `<div class="empty">No entries match these filters.</div>`;

    $('#setFacility').value = state.settings.facility;
    $('#setRoom').value = state.settings.room;
    $('#setTolerance').value = state.settings.tolerancePct;
    $('#setUnit').value = state.settings.defaultUnit;
  }

  /* -------------------------------------------------------------- exports */

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 0);
  }

  function exportCsv(kind) {
    const filter = reportFilter();
    const builders = {
      batches: () => R.batchesCsv(state),
      sessions: () => R.sessionsCsv(state, filter),
      trimmers: () => R.trimmersCsv(state, filter),
      waste: () => R.wasteCsv(state, filter),
      entries: () => R.entriesCsv(state, filter),
    };
    const build = builders[kind];
    if (!build) return;
    download(`canopy-${kind}-${R.filenameStamp()}.csv`, build());
    toast(`${kind} CSV downloaded`);
  }

  /* --------------------------------------------------------------- modals */

  function openDialog(dialog) {
    $('[data-error]', dialog).hidden = true;
    dialog.showModal();
    const first = $('input:not([type=hidden]), select', dialog);
    if (first) setTimeout(() => first.focus(), 30);
  }

  function showFormError(form, message) {
    const box = $('[data-error]', form);
    box.textContent = message;
    box.hidden = false;
  }

  function wireDialogs() {
    $$('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

    $('#formBatch').addEventListener('submit', (event) => {
      const form = event.target;
      const data = new FormData(form);
      const batch = run(() =>
        C.openBatch(state, {
          tag: data.get('tag'),
          strain: data.get('strain'),
          harvestDate: data.get('harvestDate'),
          intakeG: C.toGrams(parseFloat(data.get('intake')), data.get('unit')),
          note: data.get('note'),
        })
      );
      if (!batch) {
        event.preventDefault();
        showFormError(form, 'Could not weigh in — see the message above the tabs.');
        return;
      }
      form.reset();
      commit();
      toast(`${batch.tag} weighed in at ${g(batch.intakeG)}`);
    });

    $('#formStation').addEventListener('submit', (event) => {
      const form = event.target;
      const data = new FormData(form);
      const session = run((allowOverIssue) =>
        C.openSession(state, {
          batchId: data.get('batchId'),
          trimmer: data.get('trimmer'),
          station: data.get('station'),
          issuedG: C.toGrams(parseFloat(data.get('issued')), data.get('unit')),
          allowOverIssue,
        })
      );
      if (!session) {
        event.preventDefault();
        showFormError(form, 'Could not open the station.');
        return;
      }
      form.reset();
      ui.sessionId = session.id;
      save();
      setView('room');
      toast(`${session.trimmer} started on ${g(session.issuedG)}`);
    });

    $('#formClose').addEventListener('submit', (event) => {
      const form = event.target;
      const sessionId = form.dataset.sessionId;
      const data = new FormData(form);
      const closed = run((allowOverIssue) =>
        C.closeSession(state, sessionId, {
          returnedG: C.toGrams(parseFloat(data.get('returned')) || 0, data.get('unit')),
          allowOverIssue,
        })
      );
      if (!closed) {
        event.preventDefault();
        showFormError(form, 'Could not close the station.');
        return;
      }
      const r = C.reconcileSession(state, sessionId);
      if (ui.sessionId === sessionId) ui.sessionId = null;
      commit();
      toast(
        r.withinTolerance
          ? `${closed.trimmer} closed · variance ${num(r.varianceG)} g (${num(r.variancePct)}%)`
          : `${closed.trimmer} closed · variance ${num(r.varianceG)} g is over tolerance`,
        !r.withinTolerance
      );
    });
  }

  function promptNewBatch() {
    openDialog($('#dlgBatch'));
    $('#formBatch [name=unit]').value = state.settings.defaultUnit;
  }

  function promptOpenStation() {
    const open = C.openBatches(state);
    if (!open.length) {
      toast('Weigh in a batch first', true);
      return;
    }
    const select = $('#formStation [name=batchId]');
    select.innerHTML = open
      .map((batch) => {
        const onHand = C.reconcileBatch(state, batch.id).onHandG;
        return `<option value="${batch.id}">${esc(batch.tag)} · ${esc(batch.strain)} · ${num(onHand)} g unprocessed</option>`;
      })
      .join('');
    $('#trimmerNames').innerHTML = [...new Set(state.sessions.map((s) => s.trimmer))]
      .map((name) => `<option value="${esc(name)}"></option>`)
      .join('');
    $('#formStation [name=unit]').value = state.settings.defaultUnit;
    openDialog($('#dlgStation'));
  }

  function promptCloseStation(sessionId) {
    const r = C.reconcileSession(state, sessionId);
    const form = $('#formClose');
    form.dataset.sessionId = sessionId;
    form.reset();
    $('#formClose [name=unit]').value = state.settings.defaultUnit;
    $('#closeSummary').innerHTML = `
      <div><span>${esc(r.session.trimmer)}${r.session.station ? ' · ' + esc(r.session.station) : ''}</span><b>${r.session.id}</b></div>
      <div><span>Issued</span><b>${g(r.issuedG)}</b></div>
      <div><span>Weighed out</span><b>${g(r.outputG)}</b></div>
      <div><span>Unaccounted so far</span><b>${g(r.remainingG)}</b></div>
      <p class="hint">Weigh what is physically left on the table. Leave 0 if the station finished the material — the difference is recorded as variance.</p>`;
    openDialog($('#dlgClose'));
  }

  function voidEntry(entryId) {
    const reason = window.prompt('Why is this weigh-out being voided?\n(The entry stays in the audit log.)');
    if (reason === null) return;
    if (!reason.trim()) {
      toast('A void needs a reason', true);
      return;
    }
    const voided = run(() => C.voidEntry(state, entryId, { reason }));
    if (!voided) return;
    commit();
    toast(`${voided.id} voided`);
  }

  /* ---------------------------------------------------------------- setup */

  function setView(view) {
    ui.view = view;
    $$('#tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    render();
  }

  function wire() {
    // Waste reasons are fixed; the blank default forces a deliberate pick so
    // nothing lands on the destruction manifest without a code.
    $('#padWasteReason').innerHTML =
      '<option value="">Choose a reason…</option>' +
      C.WASTE_REASONS.map((reason) => `<option value="${reason.id}">${esc(reason.label)}</option>`).join('');

    $('#tabs').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-view]');
      if (btn) setView(btn.dataset.view);
    });

    $('#btnOpenStation').addEventListener('click', promptOpenStation);
    $('#btnNewBatch').addEventListener('click', promptNewBatch);

    $('#stationList').addEventListener('click', (event) => {
      const closeBtn = event.target.closest('[data-close-station]');
      if (closeBtn) {
        promptCloseStation(closeBtn.dataset.closeStation);
        return;
      }
      const card = event.target.closest('[data-station]');
      if (card) {
        ui.sessionId = card.dataset.station;
        renderRoom();
        $('#padWeight').focus();
      }
    });

    $('#pad').addEventListener('click', (event) => {
      const cat = event.target.closest('[data-cat]');
      if (cat) return selectCategory(cat.dataset.cat);
      const voidBtn = event.target.closest('[data-void]');
      if (voidBtn) voidEntry(voidBtn.dataset.void);
    });

    $('#padSubmit').addEventListener('click', submitEntry);
    $('#padWeight').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitEntry();
      }
    });

    $('#batchTable').addEventListener('click', (event) => {
      const closeBtn = event.target.closest('[data-close-batch]');
      if (closeBtn) {
        const batch = C.findBatch(state, closeBtn.dataset.closeBatch);
        const r = C.reconcileBatch(state, batch.id);
        const warn = r.onHandG > 0 ? `\n\n${g(r.onHandG)} is still unprocessed and will stay on the closed batch.` : '';
        if (!window.confirm(`Close ${batch.tag}?${warn}`)) return;
        if (!run(() => C.closeBatch(state, batch.id))) return;
        commit();
        toast(`${batch.tag} closed`);
        return;
      }
      const row = event.target.closest('[data-batch]');
      if (row) {
        ui.batchId = ui.batchId === row.dataset.batch ? null : row.dataset.batch;
        renderBatches();
      }
    });

    $('.range').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-range]');
      if (btn) setRange(btn.dataset.range);
    });
    ['#repFrom', '#repTo'].forEach((sel) =>
      $(sel).addEventListener('change', () => {
        ui.from = $('#repFrom').value;
        ui.to = $('#repTo').value;
        $$('.range button').forEach((btn) => btn.classList.remove('active'));
        renderReports();
      })
    );
    $('.exports').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-export]');
      if (btn) exportCsv(btn.dataset.export);
    });

    ['#logBatch', '#logCategory', '#logTrimmer', '#logVoided'].forEach((sel) =>
      $(sel).addEventListener('change', renderLog)
    );
    $('#logTable').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-void]');
      if (btn) voidEntry(btn.dataset.void);
    });

    $('#setFacility').addEventListener('change', (e) => { state.settings.facility = e.target.value.trim(); commit(); });
    $('#setRoom').addEventListener('change', (e) => { state.settings.room = e.target.value.trim(); commit(); });
    $('#setUnit').addEventListener('change', (e) => { state.settings.defaultUnit = e.target.value; commit(); });
    $('#setTolerance').addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);
      if (!Number.isFinite(value) || value < 0) {
        toast('Tolerance must be zero or more', true);
        e.target.value = state.settings.tolerancePct;
        return;
      }
      state.settings.tolerancePct = value;
      commit();
    });

    $('#btnExportJson').addEventListener('click', () => {
      download(`canopy-backup-${R.filenameStamp()}.json`, JSON.stringify(state, null, 2), 'application/json');
      toast('Backup downloaded');
    });
    $('#btnImportJson').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const restored = C.loadState(String(reader.result));
          const summary = `${restored.batches.length} batches, ${restored.sessions.length} stations, ${restored.entries.length} entries`;
          if (!window.confirm(`Restore ${summary}?\n\nThis replaces everything currently in the room.`)) return;
          state = restored;
          commit();
          toast(`Restored ${summary}`);
        } catch (err) {
          toast(`Could not restore: ${err.message}`, true);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    });

    $('#btnWipe').addEventListener('click', () => {
      if (!window.confirm('Erase every batch, station and entry in this browser?')) return;
      if (!window.confirm('This cannot be undone. Export a backup first if you need the records.')) return;
      state = C.createState();
      ui.sessionId = null;
      ui.batchId = null;
      commit();
      toast('Room cleared');
    });

    $('#btnSample').addEventListener('click', () => {
      if (state.entries.length && !window.confirm('Sample data will be added alongside your real records. Continue?')) return;
      loadSample();
      commit();
      setView('room');
      toast('Sample day loaded');
    });

    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ($('dialog[open]')) return;
      if (ui.view !== 'room' || !ui.sessionId) return;
      const target = event.target;
      const typingText = target.tagName === 'INPUT' && target.type === 'text';
      if (typingText || target.tagName === 'SELECT') return;
      const cat = C.CATEGORIES.find((c) => c.key === event.key.toLowerCase());
      if (cat) {
        event.preventDefault();
        selectCategory(cat.id);
      }
    });
  }

  /** A believable shift, for trying the room out before real material moves. */
  function loadSample() {
    const at = (hour, minute) => {
      const d = new Date();
      d.setHours(hour, minute || 0, 0, 0);
      return d.toISOString();
    };
    const batch = C.openBatch(state, {
      tag: `HL-${new Date().getFullYear()}-014`,
      strain: 'Blue Dream',
      harvestDate: C.dayKey(new Date().toISOString()),
      intakeG: 12000,
      note: 'Sample data',
      at: at(7, 30),
    });

    const plan = [
      { trimmer: 'Ana R.', station: 'Table 1', issued: 3000, out: [['A', 1320], ['B', 520], ['TRIM', 640], ['WASTE', 470, 'STEM']], returned: 0, close: at(15, 10) },
      { trimmer: 'Marco D.', station: 'Table 2', issued: 3000, out: [['A', 980], ['B', 700], ['TRIM', 720], ['WASTE', 560, 'FAN']], returned: 0, close: at(15, 20) },
      { trimmer: 'Priya S.', station: 'Table 3', issued: 2500, out: [['A', 760], ['B', 380], ['TRIM', 410], ['WASTE', 300, 'STEM']], returned: null },
    ];

    plan.forEach((row, index) => {
      const session = C.openSession(state, {
        batchId: batch.id,
        trimmer: row.trimmer,
        station: row.station,
        issuedG: row.issued,
        at: at(8, index * 5),
      });
      row.out.forEach(([category, grams, reason], step) => {
        C.addEntry(state, {
          sessionId: session.id,
          category,
          grams,
          wasteReason: reason,
          at: at(9 + step * 2, index * 7),
        });
      });
      if (row.returned !== null) C.closeSession(state, session.id, { returnedG: row.returned, at: row.close });
    });

    // One void, so the audit trail shows what a correction looks like.
    const last = state.entries[state.entries.length - 1];
    const dupe = C.addEntry(state, { sessionId: last.sessionId, category: 'B', grams: 145, at: at(14, 40) });
    C.voidEntry(state, dupe.id, { reason: 'Scale not tared', operator: 'Room lead', at: at(14, 42) });
  }

  boot();
  wire();
  wireDialogs();
  setRange('all');
  setView('room');
})();
