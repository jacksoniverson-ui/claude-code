# Canopy — trim room inventory

Tracks material through the trim room: a batch is weighed in, issued to a
trimmer's station, and weighed back out into four streams — **A buds**, **B
buds**, **trim** and **waste** — so every gram that came in can be accounted
for at the end of the shift.

No server, no install, no network. It runs from a single folder on whatever
tablet or laptop lives in the room.

## Running it

Open `index.html` in a browser, or serve the folder:

```bash
npm start          # http://localhost:8080
```

Serving is the safer option: some browsers (Safari in particular) refuse to
keep saved data for pages opened directly from a `file://` path. If the app
cannot save, it says so in a red bar across the top — export a backup before
closing the tab.

## The workflow

1. **Weigh in a batch** (Batches tab). Tag, strain and the dried, bucked
   intake weight. The tag should match the package tag in your state system.
2. **Open a station** (Room tab). Pick the batch, name the trimmer, and enter
   the weight handed to them. That weight leaves the batch's unprocessed pile.
3. **Weigh out** as the trimmer works. Pick a stream, type the weight, hit
   Enter. Keys `A` `B` `T` `W` pick the stream, so a station can be worked
   without ever touching the mouse. Waste needs a reason code before it saves.
4. **Close the station** at the end of the run. Weigh whatever is physically
   left on the table back to the batch — leave it at 0 if they finished. The
   difference is recorded as variance.
5. **Close the batch** once every station is closed.

## What reconciles against what

Per station:

```
accounted = A + B + trim + waste + returned
variance  = accounted - issued
```

Per batch:

```
on hand   = intake - issued + returned
variance  = (A + B + trim + waste + on hand) - intake
```

A batch's variance is exactly the sum of its stations' variances. Trimming dry
material sheds a little moisture, so variance is normally slightly negative;
anything past the tolerance (default **2%**, set per facility under Log &
setup) is flagged in the room, in the reports, and in the exports.

Variance only means something once every station on the batch has weighed back
in, so it reads `—` until then.

### Guardrails

- A station cannot be issued more than the batch has unprocessed, and cannot
  weigh out more than it was issued. Both can be overridden with a confirmation
  — the override exists for genuine re-weighs, and the variance still gets
  flagged. It is there to catch the 1000 g that should have been 100 g.
- Nothing is ever deleted. A bad weigh-out is **voided** with a reason: it
  drops out of the totals and stays in the audit log, marked, with who voided
  it and why.
- Waste carries a reason code (stems, fan leaf, fines, floor, contaminated,
  other) on every entry, because that is what the destruction manifest is
  built from. "Other" also requires a note.

## Reports and exports

The Reports tab covers any date range, and every table exports to CSV:

| Export | What it is for |
| --- | --- |
| Batch summary | Yield and variance per lot — the sheet the room lead signs off |
| Stations | Issued vs. weighed out vs. returned, per trimmer per run |
| Trimmers | Throughput (g/hr) and quality mix, for payroll and coaching |
| Waste manifest | Waste by day, batch and reason code, in grams and pounds |
| Full audit | Every entry ever recorded, voids included |

## Your data

Everything is stored in the browser on that one device. It is not synced, not
backed up, and not shared between tablets. **Export a backup at the end of
every shift** (Log & setup → Export backup), and restore from that JSON if the
device is lost or the browser is cleared.

If saved data is ever unreadable, the app keeps the unreadable copy in the
browser rather than overwriting it, and starts empty with a warning.

## Scope

This is the room's own log — what each trimmer produced and where the weight
went. It is **not** a state compliance system: package tags, transfers and
destruction events still have to be entered in METRC or whatever your
jurisdiction requires. The exports are shaped to make that entry quick, not to
replace it. QA and sample pulls are not waste; record those in your state
system rather than filing them under a waste reason.

## Tests

```bash
npm test
```

Covers the weight math, every guardrail, reconciliation at both levels, voids,
the save/reload path, and the CSV builders (including escaping trimmer names
that contain commas and quotes).

## Layout

```
canopy/
├── index.html        # the app shell
├── app.css           # styling; light and dark
├── src/
│   ├── domain.js     # model, guardrails, reconciliation — no DOM
│   ├── reports.js    # CSV builders
│   └── app.js        # UI wiring, persistence, exports
└── test/             # node --test, no dependencies
```

`domain.js` and `reports.js` load in both the browser and Node, so the numbers
in the UI are produced by the same code the tests exercise.
