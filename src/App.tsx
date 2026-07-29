import React, { useMemo, useState, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import {
  TrainFront,
  ArrowRightLeft,
  RotateCcw,
  BarChart3,
  Search,
  CircleCheck,
  CircleDot,
  CircleOff,
  Ticket,
  IndianRupee,
  Gauge,
  Users,
} from "lucide-react";

/* ----------------------------------------------------------------------
   SEEDED RNG — deterministic so "Reset" always returns the exact same
   synthetic dataset.
---------------------------------------------------------------------- */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----------------------------------------------------------------------
   ROUTE
---------------------------------------------------------------------- */
const STATIONS = [
  { code: "GNT", name: "Guntur Jn", hour: 0 },
  { code: "DKD", name: "Donakonda", hour: 1.0 },
  { code: "NRT", name: "Narasaraopet", hour: 2.1 },
  { code: "GID", name: "Giddalur", hour: 3.4 },
  { code: "MRK", name: "Markapur Road", hour: 4.6 },
  { code: "VKN", name: "Vinukonda", hour: 5.6 },
  { code: "ONGL", name: "Ongole", hour: 7.2 },
  { code: "NLR", name: "Nellore", hour: 9.1 },
  { code: "CHN", name: "Chennai Central", hour: 11.3 },
];
const N = STATIONS.length;
const TOTAL_HOURS = STATIONS[N - 1].hour;

const COACHES = [
  { code: "S1", type: "SL", seats: 72 },
  { code: "S2", type: "SL", seats: 72 },
  { code: "S3", type: "SL", seats: 72 },
  { code: "S4", type: "SL", seats: 72 },
  { code: "S5", type: "SL", seats: 72 },
  { code: "S6", type: "SL", seats: 72 },
  { code: "B1", type: "3A", seats: 64 },
  { code: "B2", type: "3A", seats: 64 },
  { code: "A1", type: "2A", seats: 48 },
];
const FARE = { SL: 450, "3A": 950, "2A": 1450 };
const TYPE_LABEL = { SL: "Sleeper Class", "3A": "AC 3 Tier", "2A": "AC 2 Tier" };
const TOTAL_SEATS = COACHES.reduce((s, c) => s + c.seats, 0);
const TOTAL_CAPACITY_HOURS = TOTAL_SEATS * TOTAL_HOURS;

const K_OPTIONS = [0, 1, 2, 3, 4, 5];
const CANDIDATE_POOL = 260;
const SEED = 88172645;

/* ----------------------------------------------------------------------
   DATA GENERATION
---------------------------------------------------------------------- */
function buildSeats(rng) {
  const seats = [];
  COACHES.forEach((coach) => {
    for (let berth = 1; berth <= coach.seats; berth++) {
      const roll = rng();
      let free = [];
      if (roll >= 0.15) {
        const startIdx = Math.floor(rng() * (N - 1));
        const maxLen = N - 1 - startIdx;
        const lenRoll = rng();
        let length;
        if (lenRoll < 0.12) length = maxLen;
        else if (lenRoll < 0.4) length = Math.max(1, Math.floor(maxLen * 0.6));
        else length = Math.max(1, Math.floor(rng() * Math.max(1, maxLen * 0.4)) + 1);
        length = Math.min(length, maxLen);
        free = [{ start: startIdx, end: startIdx + length }];
      }
      seats.push({
        uid: `${coach.code}-${String(berth).padStart(2, "0")}`,
        coach: coach.code,
        type: coach.type,
        berth,
        free,
      });
    }
  });
  return seats;
}

function cloneSeats(seats) {
  return seats.map((s) => ({ ...s, free: s.free.map((f) => ({ ...f })) }));
}

// Greedy interval cover: fills [from,to) using at most maxSeats free
// fragments taken from `pool` (mutated in place — consumed portions are
// removed / split).
function coverJourney(pool, from, to, maxSeats) {
  let current = from;
  const used = [];
  while (current < to && used.length < maxSeats) {
    let bestSeat = null;
    let bestFrag = null;
    let bestFragIdx = -1;
    pool.forEach((seat) => {
      seat.free.forEach((frag, idx) => {
        if (frag.start <= current && frag.end > current) {
          if (!bestFrag || frag.end > bestFrag.end) {
            bestSeat = seat;
            bestFrag = frag;
            bestFragIdx = idx;
          }
        }
      });
    });
    if (!bestSeat) break;
    const segEnd = Math.min(bestFrag.end, to);
    used.push({ uid: bestSeat.uid, coach: bestSeat.coach, type: bestSeat.type, from: current, to: segEnd });

    // consume this piece from the seat's free fragment, splitting as needed
    const leftovers = [];
    if (bestFrag.start < current) leftovers.push({ start: bestFrag.start, end: current });
    if (segEnd < bestFrag.end) leftovers.push({ start: segEnd, end: bestFrag.end });
    bestSeat.free.splice(bestFragIdx, 1, ...leftovers);

    current = segEnd;
  }
  return { success: current >= to, used, coveredTo: current };
}

function buildWaitlist(rng, seats) {
  const candidates = [];
  for (let i = 0; i < CANDIDATE_POOL; i++) {
    const full = rng() < 0.7;
    let from, to;
    if (full) {
      from = 0;
      to = N - 1;
    } else {
      from = Math.floor(rng() * (N - 2));
      const maxLen = N - 1 - from;
      const len = Math.max(1, Math.floor(rng() * maxLen) + 1);
      to = Math.min(N - 1, from + len);
    }
    candidates.push({ from, to });
  }

  // Sequentially resolve baseline (single-seat) bookings against the pool —
  // these represent passengers already confirmed through normal booking.
  // Whoever fails becomes the genuine waitlist.
  const waitlist = [];
  let wlId = 1;
  candidates.forEach((c) => {
    const res = coverJourney(seats, c.from, c.to, 1);
    if (!res.success) {
      // a single-seat fit that only covers part of the journey still
      // consumes a fragment — give it back since this candidate did not
      // actually get booked, then record them as genuinely waitlisted.
      res.used.forEach((seg) => {
        const seat = seats.find((s) => s.uid === seg.uid);
        seat.free.push({ start: seg.from, end: seg.to });
        mergeAdjacent(seat);
      });
      waitlist.push({ id: `WL${String(wlId).padStart(3, "0")}`, from: c.from, to: c.to });
      wlId++;
    }
  });
  return waitlist;
}

function initialState() {
  const rng = mulberry32(SEED);
  const rawSeats = buildSeats(rng);
  const seatsAfterBaseline = cloneSeats(rawSeats);
  const waitlist = buildWaitlist(rng, seatsAfterBaseline);
  return { baselineSeats: seatsAfterBaseline, waitlist };
}

/* ----------------------------------------------------------------------
   SIMULATION
---------------------------------------------------------------------- */
function simulate(baselineSeats, waitlist, k, generalOn) {
  const pool = cloneSeats(baselineSeats);
  const results = [];

  waitlist.forEach((p) => {
    if (k === 0 && generalOn) {
      results.push({ id: p.id, from: p.from, to: p.to, status: "general-full", used: [], coveredHours: 0 });
      return;
    }
    const maxSeats = k + 1;
    const res = coverJourney(pool, p.from, p.to, maxSeats);
    if (res.success) {
      results.push({ id: p.id, from: p.from, to: p.to, status: "confirmed", used: res.used });
    } else if (generalOn) {
      const gotAny = res.coveredTo > p.from;
      results.push({
        id: p.id,
        from: p.from,
        to: p.to,
        status: gotAny ? "general-partial" : "general-full",
        used: res.used,
        coveredTo: res.coveredTo,
      });
    } else {
      // roll back nothing needed: partial consumption for a failed,
      // non-general passenger still represents real seats they'd hold if
      // we let them — since they refuse general and aren't confirmed, give
      // those fragments back to the pool.
      res.used.forEach((seg) => {
        const seat = pool.find((s) => s.uid === seg.uid);
        seat.free.push({ start: seg.from, end: seg.to });
        seat.free.sort((a, b) => a.start - b.start);
        mergeAdjacent(seat);
      });
      results.push({ id: p.id, from: p.from, to: p.to, status: "waitlisted", used: [] });
    }
  });

  const confirmed = results.filter((r) => r.status === "confirmed");
  const genPartial = results.filter((r) => r.status === "general-partial");
  const genFull = results.filter((r) => r.status === "general-full");
  const stillWL = results.filter((r) => r.status === "waitlisted");

  const hoursOf = (idx) => STATIONS[idx].hour;
  let newlyFilledHours = 0;
  confirmed.forEach((r) => (newlyFilledHours += hoursOf(r.to) - hoursOf(r.from)));
  genPartial.forEach((r) => (newlyFilledHours += hoursOf(r.coveredTo) - hoursOf(r.from)));

  let revenue = 0;
  [...confirmed, ...genPartial].forEach((r) => {
    if (r.used.length) revenue += FARE[r.used[0].type];
  });

  const avgGeneralHrs =
    genPartial.length > 0
      ? genPartial.reduce((sum, r) => sum + (hoursOf(r.to) - hoursOf(r.coveredTo)), 0) / genPartial.length
      : 0;

  return {
    k,
    generalOn,
    pool,
    results,
    metrics: {
      total: waitlist.length,
      confirmed: confirmed.length,
      genPartial: genPartial.length,
      genFull: genFull.length,
      stillWL: stillWL.length,
      confirmRate: (confirmed.length / waitlist.length) * 100,
      coveredRate: ((confirmed.length + genPartial.length + genFull.length) / waitlist.length) * 100,
      newlyFilledHours,
      utilizationExtra: (newlyFilledHours / TOTAL_CAPACITY_HOURS) * 100,
      revenue,
      avgGeneralHrs,
    },
  };
}

function mergeAdjacent(seat) {
  seat.free.sort((a, b) => a.start - b.start);
  const merged = [];
  seat.free.forEach((f) => {
    if (merged.length && merged[merged.length - 1].end === f.start) {
      merged[merged.length - 1].end = f.end;
    } else {
      merged.push(f);
    }
  });
  seat.free = merged;
}

/* ----------------------------------------------------------------------
   UI HELPERS
---------------------------------------------------------------------- */
const STATUS_META = {
  confirmed: { label: "Confirmed", color: "var(--ok)", Icon: CircleCheck },
  "general-partial": { label: "Partial + General", color: "var(--warn)", Icon: CircleDot },
  "general-full": { label: "General (full trip)", color: "var(--warn2)", Icon: CircleDot },
  waitlisted: { label: "Still Waitlisted", color: "var(--bad)", Icon: CircleOff },
};

function pct(n) {
  return `${n.toFixed(1)}%`;
}
function hrs(n) {
  return `${n.toFixed(1)} hrs`;
}
function stCode(idx) {
  return STATIONS[idx].code;
}

/* ----------------------------------------------------------------------
   MAIN COMPONENT
---------------------------------------------------------------------- */
export default function SeatBridge() {
  const [gen, setGen] = useState(0); // bump to force full dataset regeneration
  const base = useMemo(() => initialState(), [gen]);

  return (
    <div className="sb-root">
      <style>{CSS}</style>

      {/* ---------- HEADER ---------- */}
      <header className="sb-header">
        <div className="sb-header-top">
          <div className="sb-brand">
            <TrainFront size={22} strokeWidth={1.75} />
            <span>SeatBridge</span>
          </div>
          <div className="sb-tag">a segment-covering allocator for waitlisted rail journeys</div>
        </div>
        <div className="sb-board">
          <BoardField label="Train" value="17261" />
          <BoardField label="Route" value={`${STATIONS[0].code} → ${STATIONS[N - 1].code}`} />
          <BoardField label="Journey" value={`${TOTAL_HOURS.toFixed(1)} hrs · ${N} stops`} />
          <BoardField label="Seats" value={String(TOTAL_SEATS)} />
          <BoardField label="Waitlist" value={String(base.waitlist.length)} flip />
        </div>
      </header>
    </div>
  );
}

/* ----------------------------------------------------------------------
   SMALL PRESENTATIONAL PIECES
---------------------------------------------------------------------- */
function BoardField({ label, value, flip }) {
  return (
    <div className="sb-board-field">
      <div className="sb-board-label">{label}</div>
      <div className={`sb-board-value ${flip ? "flip" : ""}`}>{value}</div>
    </div>
  );
}

function MetricCard({ icon, label, value, sub, delta }) {
  return (
    <div className="sb-metric">
      <div className="sb-metric-icon">{icon}</div>
      <div className="sb-metric-label">{label}</div>
      <div className="sb-metric-value">{value}</div>
      <div className="sb-metric-sub">
        {sub}
        {delta !== null && delta !== undefined && (
          <span className={`sb-delta ${delta >= 0 ? "up" : "down"}`}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} pts vs last run
          </span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------
   STYLES
---------------------------------------------------------------------- */
const CSS = `
:root {
  --bg: #0a0f1a;
  --panel: #0f1626;
  --panel2: #131c30;
  --line: #223050;
  --text: #e7ecf7;
  --muted: #8b96b3;
  --accent: #4fd1c5;
  --accent2: #6c8dfa;
  --ok: #34d399;
  --warn: #f5b942;
  --warn2: #f0904d;
  --bad: #f3667a;
}
.sb-root {
  background: radial-gradient(1200px 600px at 10% -10%, #10203a 0%, var(--bg) 55%);
  color: var(--text);
  font-family: 'IBM Plex Sans', 'Inter', system-ui, sans-serif;
  padding: 28px;
  min-height: 100%;
  box-sizing: border-box;
}
.sb-root * { box-sizing: border-box; }

.sb-header { margin-bottom: 22px; }
.sb-header-top { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.sb-brand {
  display: flex; align-items: center; gap: 8px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 22px; font-weight: 600; letter-spacing: 0.5px; color: var(--accent);
}
.sb-tag { color: var(--muted); font-size: 13.5px; }

.sb-board {
  display: flex; flex-wrap: wrap; gap: 0;
  background: #060a13;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.sb-board-field { padding: 10px 18px; border-right: 1px solid var(--line); flex: 1; min-width: 120px; }
.sb-board-field:last-child { border-right: none; }
.sb-board-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); margin-bottom: 4px; }
.sb-board-value { font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 600; color: var(--text); }
.sb-board-value.flip { color: var(--warn); }

.sb-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 18px;
}
.sb-panel-row { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-end; justify-content: space-between; }
.sb-control-block { display: flex; flex-direction: column; gap: 8px; }
.sb-control-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.sb-k-group { display: flex; gap: 6px; flex-wrap: wrap; }
.sb-k-btn {
  background: var(--panel2); border: 1px solid var(--line); color: var(--text);
  padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 13.5px; font-family: 'IBM Plex Mono', monospace;
  transition: all .15s ease;
}
.sb-k-btn:hover { border-color: var(--accent2); }
.sb-k-btn.active { background: var(--accent2); border-color: var(--accent2); color: #06101f; font-weight: 700; }

.sb-check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--text); cursor: pointer; }
.sb-check input { width: 16px; height: 16px; accent-color: var(--accent); }

.sb-panel-actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
.sb-btn {
  display: flex; align-items: center; gap: 7px;
  background: var(--panel2); border: 1px solid var(--line); color: var(--text);
  padding: 9px 16px; border-radius: 8px; cursor: pointer; font-size: 13.5px; font-weight: 500;
  transition: all .15s ease;
}
.sb-btn:hover { border-color: var(--accent2); }
.sb-btn.primary { background: var(--accent); border-color: var(--accent); color: #06101f; font-weight: 700; }
.sb-btn.primary:hover { filter: brightness(1.08); }
.sb-btn.ghost { background: transparent; }

.sb-hint { color: var(--muted); font-size: 13.5px; padding: 14px 4px; margin-bottom: 6px; }

.sb-metrics {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px; margin-bottom: 20px;
}
.sb-metric {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
}
.sb-metric-icon { color: var(--accent); margin-bottom: 6px; }
.sb-metric-label { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; margin-bottom: 6px; }
.sb-metric-value { font-family: 'IBM Plex Mono', monospace; font-size: 22px; font-weight: 700; }
.sb-metric-sub { font-size: 12px; color: var(--muted); margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.sb-delta { font-size: 11.5px; font-family: 'IBM Plex Mono', monospace; }
.sb-delta.up { color: var(--ok); }
.sb-delta.down { color: var(--bad); }

.sb-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; margin-bottom: 18px; }
.sb-card-title { font-size: 15.5px; font-weight: 700; margin-bottom: 14px; }
.sb-card-title.small { font-size: 13.5px; color: var(--muted); font-weight: 600; }
.sb-card-title-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.sb-card-note { font-size: 12px; color: var(--muted); margin-top: 8px; }

.sb-tabs { display: flex; gap: 6px; }
.sb-tab { background: var(--panel2); border: 1px solid var(--line); color: var(--muted); padding: 6px 12px; border-radius: 20px; font-size: 12.5px; cursor: pointer; }
.sb-tab.active { background: var(--accent2); border-color: var(--accent2); color: #06101f; font-weight: 700; }

.sb-heatmap { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.sb-coach-block { display: flex; align-items: center; gap: 12px; }
.sb-coach-label { width: 32px; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: var(--muted); flex-shrink: 0; }
.sb-coach-grid { display: flex; flex-wrap: wrap; gap: 3px; }
.sb-seat { width: 10px; height: 10px; border-radius: 2px; }
.sb-seat.free { background: var(--ok); }
.sb-seat.partial { background: var(--warn); }
.sb-seat.occupied { background: #2a3450; }

.sb-legend { display: flex; gap: 18px; margin-top: 12px; font-size: 12px; color: var(--muted); }
.sb-dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.sb-dot.free { background: var(--ok); }
.sb-dot.partial { background: var(--warn); }
.sb-dot.occupied { background: #2a3450; }

.sb-search { display: flex; align-items: center; gap: 6px; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; color: var(--muted); }
.sb-search input { background: transparent; border: none; outline: none; color: var(--text); font-size: 12.5px; width: 190px; }

.sb-table-wrap { max-height: 260px; overflow-y: auto; margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; }
.sb-table-wrap.tall { max-height: 380px; }
.sb-table { width: 100%; border-collapse: collapse; font-size: 12.8px; }
.sb-table thead th {
  position: sticky; top: 0; background: var(--panel2); text-align: left; padding: 9px 12px;
  font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); border-bottom: 1px solid var(--line);
}
.sb-table td { padding: 8px 12px; border-bottom: 1px solid #182238; }
.sb-table tr:hover td { background: #101a30; }
.sb-table td.mono { font-family: 'IBM Plex Mono', monospace; }
.sb-status { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.sb-detail { color: var(--muted); }
.sb-empty { text-align: center; color: var(--muted); padding: 20px !important; }

.sb-footer { color: var(--muted); font-size: 11.5px; text-align: center; margin-top: 8px; padding: 10px 0; }
\`;