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

  const [k, setK] = useState(0);
  const [generalOn, setGeneralOn] = useState(false);
  const [applied, setApplied] = useState(null); // simulate() result
  const [prevMetrics, setPrevMetrics] = useState(null);
  const [compareData, setCompareData] = useState(null);
  const [coachTab, setCoachTab] = useState("SL");
  const [wlFilter, setWlFilter] = useState("");
  const [berthFilter, setBerthFilter] = useState("");

  const displaySeats = applied ? applied.pool : base.baselineSeats;

  const applySimulation = useCallback(() => {
    setPrevMetrics(applied ? applied.metrics : { confirmRate: 0, coveredRate: 0, utilizationExtra: 0, revenue: 0 });
    const result = simulate(base.baselineSeats, base.waitlist, k, generalOn);
    setApplied(result);
    setCompareData(null);
  }, [applied, base, k, generalOn]);

  const handleCompare = useCallback(() => {
    const rows = K_OPTIONS.map((kk) => {
      const withGen = simulate(base.baselineSeats, base.waitlist, kk, true);
      const noGen = simulate(base.baselineSeats, base.waitlist, kk, false);
      return {
        k: kk === 0 ? "0 (current)" : String(kk),
        Confirmed: Number(noGen.metrics.confirmRate.toFixed(1)),
        "Partial + General": Number((withGen.metrics.genPartial / base.waitlist.length * 100).toFixed(1)),
        "Full General": Number((withGen.metrics.genFull / base.waitlist.length * 100).toFixed(1)),
        "Still Waitlisted": Number((withGen.metrics.stillWL / base.waitlist.length * 100).toFixed(1)),
        revenue: noGen.metrics.revenue,
      };
    });
    setCompareData(rows);
  }, [base]);

  const handleReset = useCallback(() => {
    setGen((g) => g + 1);
    setK(0);
    setGeneralOn(false);
    setApplied(null);
    setPrevMetrics(null);
    setCompareData(null);
    setWlFilter("");
    setBerthFilter("");
  }, []);

  const m = applied?.metrics;
  const dConfirmRate = m && prevMetrics ? m.confirmRate - prevMetrics.confirmRate : null;
  const dCoveredRate = m && prevMetrics ? m.coveredRate - prevMetrics.coveredRate : null;

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

      {/* ---------- CONTROL PANEL ---------- */}
      <section className="sb-panel">
        <div className="sb-panel-row">
          <div className="sb-control-block">
            <div className="sb-control-label">
              <ArrowRightLeft size={15} /> Seat-change tolerance (max switches per passenger)
            </div>
            <div className="sb-k-group">
              {K_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  className={`sb-k-btn ${k === opt ? "active" : ""}`}
                  onClick={() => setK(opt)}
                >
                  {opt === 0 ? "0 · none" : opt}
                </button>
              ))}
            </div>
          </div>

          <label className="sb-check">
            <input type="checkbox" checked={generalOn} onChange={(e) => setGeneralOn(e.target.checked)} />
            <span>Fall back to General class for any uncovered portion</span>
          </label>
        </div>

        <div className="sb-panel-actions">
          <button className="sb-btn primary" onClick={applySimulation}>
            <Gauge size={16} /> Apply simulation
          </button>
          <button className="sb-btn" onClick={handleCompare}>
            <BarChart3 size={16} /> Compare 0–5
          </button>
          <button className="sb-btn ghost" onClick={handleReset}>
            <RotateCcw size={16} /> Reset to start
          </button>
        </div>
      </section>

      {/* ---------- METRICS ---------- */}
      {applied && (
        <section className="sb-metrics">
          <MetricCard
            icon={<Users size={16} />}
            label="Waitlist before"
            value={m.total}
            sub={`${m.stillWL} still unresolved`}
          />
          <MetricCard
            icon={<CircleCheck size={16} />}
            label="Confirmed via seat-change"
            value={m.confirmed}
            sub={pct(m.confirmRate)}
            delta={dConfirmRate}
          />
          <MetricCard
            icon={<Ticket size={16} />}
            label="Covered overall (+General)"
            value={m.confirmed + m.genPartial + m.genFull}
            sub={pct(m.coveredRate)}
            delta={dCoveredRate}
          />
          <MetricCard
            icon={<Gauge size={16} />}
            label="Extra seat-hours utilised"
            value={hrs(m.newlyFilledHours)}
            sub={`${pct(m.utilizationExtra)} of train capacity`}
          />
          <MetricCard
            icon={<IndianRupee size={16} />}
            label="Est. extra revenue"
            value={`₹${m.revenue.toLocaleString("en-IN")}`}
            sub="illustrative fare estimate"
          />
          <MetricCard
            icon={<CircleDot size={16} />}
            label="General fallback used"
            value={m.genPartial + m.genFull}
            sub={m.genPartial ? `avg ${hrs(m.avgGeneralHrs)} in general` : "—"}
          />
        </section>
      )}
      {!applied && (
        <div className="sb-hint">
          Pick a seat-change tolerance above and hit <b>Apply simulation</b> to see how many of the{" "}
          <b>{base.waitlist.length}</b> genuinely waitlisted passengers this train could additionally confirm.
        </div>
      )}

      {/* ---------- COMPARE CHART ---------- */}
      {compareData && (
        <section className="sb-card">
          <div className="sb-card-title">Confirmation outcome by seat-change tolerance</div>
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={compareData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="k" tick={{ fill: "var(--muted)", fontSize: 12 }} label={{ value: "max seat changes", position: "insideBottom", offset: -2, fill: "var(--muted)", fontSize: 11 }} />
                <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} unit="%" />
                <Tooltip
                  contentStyle={{ background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }}
                  formatter={(v) => `${v}%`}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
                <Bar dataKey="Confirmed" stackId="a" fill="var(--ok)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="Partial + General" stackId="a" fill="var(--warn)" />
                <Bar dataKey="Full General" stackId="a" fill="var(--warn2)" />
                <Bar dataKey="Still Waitlisted" stackId="a" fill="var(--bad)">
                  <LabelList dataKey="revenue" position="top" formatter={(v) => `₹${v.toLocaleString("en-IN")}`} fill="var(--muted)" fontSize={10} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="sb-card-note">
            Top label on each bar shows estimated extra ticket revenue at that tolerance (reserved-class fares only, general excluded).
          </div>
        </section>
      )}

      {/* ---------- COACH EXPLORER ---------- */}
      <section className="sb-card">
        <div className="sb-card-title-row">
          <div className="sb-card-title">Coach vacancy explorer</div>
          <div className="sb-tabs">
            {["SL", "3A", "2A"].map((t) => (
              <button key={t} className={`sb-tab ${coachTab === t ? "active" : ""}`} onClick={() => setCoachTab(t)}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="sb-heatmap">
          {heatmapCoaches.map((coach) => {
            const coachSeats = displaySeats.filter((s) => s.coach === coach.code);
            return (
              <div className="sb-coach-block" key={coach.code}>
                <div className="sb-coach-label">{coach.code}</div>
                <div className="sb-coach-grid">
                  {coachSeats.map((s) => {
                    const freeHours = s.free.reduce((sum, f) => sum + (STATIONS[f.end].hour - STATIONS[f.start].hour), 0);
                    const frac = TOTAL_HOURS > 0 ? freeHours / TOTAL_HOURS : 0;
                    let cls = "occupied";
                    if (frac > 0.85) cls = "free";
                    else if (frac > 0) cls = "partial";
                    return <div key={s.uid} className={`sb-seat ${cls}`} title={`${s.uid} · ${freeHours.toFixed(1)}h free`} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="sb-legend">
          <span><i className="sb-dot free" /> mostly free</span>
          <span><i className="sb-dot partial" /> fragment free</span>
          <span><i className="sb-dot occupied" /> occupied</span>
        </div>

        <div className="sb-card-title-row" style={{ marginTop: 22 }}>
          <div className="sb-card-title small">Vacant berth details — {TYPE_LABEL[coachTab]}</div>
          <div className="sb-search">
            <Search size={14} />
            <input placeholder="search coach, berth, station…" value={berthFilter} onChange={(e) => setBerthFilter(e.target.value)} />
          </div>
        </div>
        <div className="sb-table-wrap">
          <table className="sb-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Coach</th>
                <th>Berth</th>
              </tr>
            </thead>
            <tbody>
              {berthRows.slice(0, 400).map((r, i) => (
                <tr key={i}>
                  <td>{STATIONS[r.from].name} ({stCode(r.from)})</td>
                  <td>{STATIONS[r.to].name} ({stCode(r.to)})</td>
                  <td>{r.coach}</td>
                  <td>{r.berth}</td>
                </tr>
              ))}
              {berthRows.length === 0 && (
                <tr><td colSpan={4} className="sb-empty">No vacant fragments match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
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