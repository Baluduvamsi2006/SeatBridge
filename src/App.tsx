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
   TYPES
---------------------------------------------------------------------- */
interface Station {
  code: string;
  name: string;
  hour: number;
}

interface Coach {
  code: string;
  type: "SL" | "3A" | "2A";
  seats: number;
}

interface Seat {
  uid: string;
  coach: string;
  type: "SL" | "3A" | "2A";
  berth: number;
  free: { start: number; end: number }[];
}

interface Segment {
  uid: string;
  coach: string;
  type: "SL" | "3A" | "2A";
  from: number;
  to: number;
}

interface WaitlistedPassenger {
  id: string;
  from: number;
  to: number;
}

interface SimulationResult {
  id: string;
  from: number;
  to: number;
  status: "confirmed" | "general-partial" | "general-full" | "waitlisted";
  used: Segment[];
  coveredTo?: number;
}

interface SimulationMetrics {
  total: number;
  confirmed: number;
  genPartial: number;
  genFull: number;
  stillWL: number;
  confirmRate: number;
  coveredRate: number;
  newlyFilledHours: number;
  utilizationExtra: number;
  revenue: number;
  avgGeneralHrs: number;
}

interface SimulationOutput {
  k: number;
  generalOn: boolean;
  pool: Seat[];
  results: SimulationResult[];
  metrics: SimulationMetrics;
}

/* ----------------------------------------------------------------------
   SEEDED RNG — deterministic so "Reset" always returns the exact same
   synthetic dataset.
---------------------------------------------------------------------- */
function mulberry32(seed: number) {
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
function randomFragment(rng: () => number) {
  const startIdx = Math.floor(rng() * (N - 1));
  const maxLen = N - 1 - startIdx;
  const lenRoll = rng();
  let length;
  if (lenRoll < 0.12) length = maxLen;
  else if (lenRoll < 0.4) length = Math.max(1, Math.floor(maxLen * 0.6));
  else length = Math.max(1, Math.floor(rng() * Math.max(1, maxLen * 0.4)) + 1);
  length = Math.min(length, maxLen);
  return { start: startIdx, end: startIdx + length };
}

function buildSeats(rng: () => number): Seat[] {
  const seats = [];
  COACHES.forEach((coach) => {
    for (let berth = 1; berth <= coach.seats; berth++) {
      const roll = rng();
      let free = [];
      if (roll >= 0.15) {
        free.push(randomFragment(rng));
        // ~22% of seats get a second, disjoint pocket of availability —
        // e.g. someone boards midway then someone else alights before the
        // end — this is what makes multi-seat coverage possible at all.
        if (rng() < 0.22) {
          const second = randomFragment(rng);
          const overlaps = free.some((f) => second.start < f.end && f.start < second.end);
          if (!overlaps) {
            free.push(second);
            free.sort((a, b) => a.start - b.start);
          }
        }
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

function cloneSeats(seats: Seat[]): Seat[] {
  return seats.map((s) => ({ ...s, free: s.free.map((f) => ({ ...f })) }));
}

// Greedy interval cover: fills [from,to) using at most maxSeats free
// fragments taken from `pool` (mutated in place — consumed portions are
// removed / split).
function coverJourney(pool: Seat[], from: number, to: number, maxSeats: number) {
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

function buildWaitlist(rng: () => number, seats: Seat[]): WaitlistedPassenger[] {
  const HUBS = [5, 6, 7]; // VKN, ONGL, NLR — intermediate demand hubs
  const candidates = [];
  for (let i = 0; i < CANDIDATE_POOL; i++) {
    const bucket = rng();
    let from, to;
    if (bucket < 0.3) {
      // headed all the way to the final stop, boarding at a variety of
      // stations (skewed toward the origin — that's where demand peaks —
      // but not exclusively, so the route column stays varied)
      from = Math.floor(rng() * rng() * (N - 1));
      to = N - 1;
    } else if (bucket < 0.6) {
      // headed to a major intermediate hub, not the terminus
      to = HUBS[Math.floor(rng() * HUBS.length)];
      from = Math.floor(rng() * to);
    } else {
      // any other random sub-journey
      from = Math.floor(rng() * (N - 2));
      const maxLen = N - 1 - from;
      const len = Math.max(1, Math.floor(rng() * maxLen) + 1);
      to = Math.min(N - 1, from + len);
    }
    if (to <= from) to = Math.min(N - 1, from + 1);
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
function simulate(baselineSeats: Seat[], waitlist: WaitlistedPassenger[], k: number, generalOn: boolean): SimulationOutput {
  const pool = cloneSeats(baselineSeats);
  const results = [];

  waitlist.forEach((p: WaitlistedPassenger) => {
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

function mergeAdjacent(seat: Seat) {
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

function seatTimeline(seat: Seat | null | undefined) {
  if (!seat) return [];
  const segs = [];
  let cursor = 0;
  const free = [...seat.free].sort((a, b) => a.start - b.start);
  free.forEach((f) => {
    if (f.start > cursor) segs.push({ from: cursor, to: f.start, type: "occupied" });
    segs.push({ from: f.start, to: f.end, type: "free" });
    cursor = f.end;
  });
  if (cursor < N - 1) segs.push({ from: cursor, to: N - 1, type: "occupied" });
  if (segs.length === 0) segs.push({ from: 0, to: N - 1, type: "occupied" });
  return segs;
}

function pct(n: number) {
  return `${n.toFixed(1)}%`;
}
function hrs(n: number) {
  return `${n.toFixed(1)} hrs`;
}
function stCode(idx: number) {
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
  const [applied, setApplied] = useState<any>(null); // simulate() result
  const [prevMetrics, setPrevMetrics] = useState<any>(null);
  const [compareData, setCompareData] = useState<any>(null);
  const [coachTab, setCoachTab] = useState("SL");
  const [wlFilter, setWlFilter] = useState("");
  const [berthFilter, setBerthFilter] = useState("");
  const [selectedSeatUid, setSelectedSeatUid] = useState<any>(null);
  const [wlSeatCountFilter, setWlSeatCountFilter] = useState("all");

  const displaySeats = applied ? applied.pool : base.baselineSeats;

  const applySimulation = useCallback(() => {
    setPrevMetrics(applied ? applied.metrics : { confirmRate: 0, coveredRate: 0, utilizationExtra: 0, revenue: 0 });
    const result = simulate(base.baselineSeats, base.waitlist, k, generalOn);
    setApplied(result);
    setCompareData(null);
  }, [applied, base, k, generalOn]);

  const handleCompare = useCallback(() => {
    const total = base.waitlist.length;
    const rows = K_OPTIONS.map((kk) => {
      const res = simulate(base.baselineSeats, base.waitlist, kk, generalOn);
      return {
        k: kk === 0 ? "0 (current)" : String(kk),
        Confirmed: Number(((res.metrics.confirmed / total) * 100).toFixed(1)),
        "Partial + General": Number(((res.metrics.genPartial / total) * 100).toFixed(1)),
        "Full General": Number(((res.metrics.genFull / total) * 100).toFixed(1)),
        "Still Waitlisted": Number(((res.metrics.stillWL / total) * 100).toFixed(1)),
        revenue: res.metrics.revenue,
      };
    });
    setCompareData({ rows, generalOn });
  }, [base, generalOn]);

  const handleReset = useCallback(() => {
    setGen((g) => g + 1);
    setK(0);
    setGeneralOn(false);
    setApplied(null);
    setPrevMetrics(null);
    setCompareData(null);
    setWlFilter("");
    setBerthFilter("");
    setSelectedSeatUid(null);
    setWlSeatCountFilter("all");
  }, []);

  const m = applied?.metrics;
  const dConfirmRate = m && prevMetrics ? m.confirmRate - prevMetrics.confirmRate : null;
  const dCoveredRate = m && prevMetrics ? m.coveredRate - prevMetrics.coveredRate : null;

  const wlBucketOf = useCallback((r: any) => {
    if (r.status === "confirmed") return `confirmed-${r.used.length}`;
    if (r.status === "general-partial") return "general-partial";
    if (r.status === "general-full") return "general-full";
    return "waitlisted";
  }, []);

  const allWlRows = applied ? applied.results : base.waitlist.map((p) => ({ ...p, status: "waitlisted", used: [] }));

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    allWlRows.forEach((r: any) => {
      const b = wlBucketOf(r);
      counts[b] = (counts[b] || 0) + 1;
    });
    return counts;
  }, [allWlRows, wlBucketOf]);

  const filteredWL = useMemo(() => {
    let list = allWlRows;
    if (wlSeatCountFilter !== "all") {
      list = list.filter((r) => wlBucketOf(r) === wlSeatCountFilter);
    }
    if (!wlFilter.trim()) return list;
    const f = wlFilter.trim().toUpperCase();
    return list.filter(
      (r) =>
        r.id.includes(f) ||
        stCode(r.from).includes(f) ||
        stCode(r.to).includes(f) ||
        (STATUS_META[r.status as keyof typeof STATUS_META]?.label || "").toUpperCase().includes(f)
    );
  }, [allWlRows, wlFilter, wlSeatCountFilter, wlBucketOf]);

  const berthRows = useMemo(() => {
    const rows = [];
    displaySeats
      .filter((s: Seat) => s.type === coachTab)
      .forEach((s: Seat) => {
        s.free.forEach((f) => {
          rows.push({ uid: s.uid, coach: s.coach, berth: s.berth, from: f.start, to: f.end });
        });
      });
    rows.sort((a, b) => (a.coach === b.coach ? a.berth - b.berth : a.coach.localeCompare(b.coach)));
    if (!berthFilter.trim()) return rows;
    const f = berthFilter.trim().toUpperCase();
    return rows.filter(
      (r) => r.coach.includes(f) || String(r.berth).includes(f) || stCode(r.from).includes(f) || stCode(r.to).includes(f)
    );
  }, [displaySeats, coachTab, berthFilter]);

  const heatmapCoaches = COACHES.filter((c: any) => c.type === coachTab);

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
      {(() => {
        const controlPanel = (
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
        );

        const statsBlock = (
          <>
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
                Pick a seat-change tolerance below and hit <b>Apply simulation</b> to see how many of the{" "}
                <b>{base.waitlist.length}</b> genuinely waitlisted passengers this train could additionally confirm.
              </div>
            )}
          </>
        );

        return (
          <>
            {statsBlock}
            {controlPanel}
          </>
        );
      })()}

      {/* ---------- COMPARE CHART ---------- */}
      {compareData && (
        <section className="sb-card">
          <div className="sb-card-title">
            Confirmation outcome by seat-change tolerance
            <span className="sb-scenario-tag">General fallback: {compareData.generalOn ? "ON" : "OFF"}</span>
          </div>
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={compareData.rows as any} margin={{ top: 35, right: 20, left: -10, bottom: 10 }} barSize={52}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="k" tick={{ fill: "var(--muted)", fontSize: 12 }} label={{ value: "max seat changes", position: "insideBottom", offset: -10, fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "var(--muted)", fontSize: 12 }} unit="%" domain={[0, 100]} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                  contentStyle={{ background: "rgba(15, 22, 38, 0.85)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "var(--text)", boxShadow: "0 4px 16px rgba(0,0,0,0.5)" }}
                  itemStyle={{ fontSize: 13, fontWeight: 500 }}
                  formatter={(v: any) => `${v}%`}
                />
                <Legend wrapperStyle={{ fontSize: 13, color: "var(--muted)", paddingTop: 20 }} iconType="circle" />
                <Bar dataKey="Confirmed" stackId="a" fill="var(--ok)" radius={[4, 4, 4, 4]} stroke="var(--panel)" strokeWidth={3} />
                <Bar dataKey="Partial + General" stackId="a" fill="var(--warn)" radius={[4, 4, 4, 4]} stroke="var(--panel)" strokeWidth={3} />
                <Bar dataKey="Full General" stackId="a" fill="var(--warn2)" radius={[4, 4, 4, 4]} stroke="var(--panel)" strokeWidth={3} />
                <Bar dataKey="Still Waitlisted" stackId="a" fill="var(--bad)" radius={[4, 4, 4, 4]} stroke="var(--panel)" strokeWidth={3}>
                  <LabelList dataKey="revenue" position="top" formatter={(v: any) => `₹${v.toLocaleString("en-IN")}`} fill="var(--text)" fontSize={12} fontWeight={600} offset={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="sb-card-note">
            Each bar sums to 100% of the {base.waitlist.length} waitlisted passengers at that tolerance.{" "}
            {compareData.generalOn ? (
              <>
                General fallback is <b>ON</b>, so nobody stays fully stuck: <b>Partial + General</b> = got some
                reserved seats then finished the trip in General; <b>Full General</b> = tolerance couldn't cover any
                part of their journey, so they ride General the whole way. Untick the checkbox above and hit Compare
                again to see the no-General picture, where "Still Waitlisted" is the one that matters.
              </>
            ) : (
              <>
                General fallback is <b>OFF</b>, so this is just Confirmed vs. Still Waitlisted — at tolerance 0
                that's today's system, 100% waitlisted. Tick the General checkbox above and hit Compare again to see
                how a General fallback changes this.
              </>
            )}
            {" "}Top label = estimated extra reserved-class ticket revenue at that tolerance.
          </div>
        </section>
      )}

      {/* ---------- COACH EXPLORER ---------- */}
      <section className="sb-card">
        <div className="sb-card-title-row">
          <div className="sb-card-title">Coach vacancy explorer</div>
          <div className="sb-tabs">
            {["SL", "3A", "2A"].map((t) => (
              <button key={t} className={`sb-tab ${coachTab === t ? "active" : ""}`} onClick={() => setCoachTab(t as any)}>
                {TYPE_LABEL[t as keyof typeof TYPE_LABEL]}
              </button>
            ))}
          </div>
        </div>

        <div className="sb-heatmap">
          {heatmapCoaches.map((coach) => {
            const coachSeats = displaySeats.filter((s: Seat) => s.coach === coach.code);
            return (
              <div className="sb-coach-block" key={coach.code}>
                <div className="sb-coach-label">{coach.code}</div>
                <div className="sb-coach-grid">
                  {coachSeats.map((s: Seat) => {
                    const freeHours = s.free.reduce((sum, f) => sum + (STATIONS[f.end].hour - STATIONS[f.start].hour), 0);
                    const frac = TOTAL_HOURS > 0 ? freeHours / TOTAL_HOURS : 0;
                    let cls = "occupied";
                    if (frac > 0.85) cls = "free";
                    else if (frac > 0) cls = "partial";
                    return (
                      <button
                        key={s.uid}
                        className={`sb-seat ${cls} ${selectedSeatUid === s.uid ? "selected" : ""}`}
                        title={`${s.uid} · ${freeHours.toFixed(1)}h free`}
                        onClick={() => setSelectedSeatUid(s.uid === selectedSeatUid ? null : s.uid)}
                      >
                        {s.berth}
                      </button>
                    );
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
          <span className="sb-legend-hint">click any seat to inspect its booking timeline</span>
        </div>

        {(() => {
          const seat = selectedSeatUid ? displaySeats.find((s) => s.uid === selectedSeatUid) : null;
          if (!seat) {
            return <div className="sb-inspector empty">Click any seat above to see exactly where it's booked and where it's free.</div>;
          }
          const timeline = seatTimeline(seat);
          return (
            <div className="sb-inspector">
              <div className="sb-inspector-head">
                <span className="mono">{seat.uid}</span>
                <span className="sb-inspector-sub">{TYPE_LABEL[seat.type]} · berth {seat.berth}</span>
                <button className="sb-chip-close" onClick={() => setSelectedSeatUid(null)}>✕ close</button>
              </div>
              <div className="sb-timeline">
                {timeline.map((seg: any, i: number) => (
                  <div key={i} className={`sb-timeline-seg ${seg.type}`} title={`${stCode(seg.from)} → ${stCode(seg.to)}`}>
                    {stCode(seg.from)} → {stCode(seg.to)}
                  </div>
                ))}
              </div>
              <div className="sb-inspector-legend">
                <span><i className="sb-dot occupied" /> already booked (from normal booking)</span>
                <span><i className="sb-dot free" /> free — available to cover a waitlisted passenger's segment</span>
              </div>
            </div>
          );
        })()}

        <div className="sb-card-title-row" style={{ marginTop: 22 }}>
          <div className="sb-card-title small">Vacant berth details — {TYPE_LABEL[coachTab as keyof typeof TYPE_LABEL]}</div>
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

      {/* ---------- WAITLIST TABLE ---------- */}
      <section className="sb-card">
        <div className="sb-card-title-row">
          <div className="sb-card-title">Waitlisted passengers ({base.waitlist.length})</div>
          <div className="sb-search">
            <Search size={14} />
            <input placeholder="search id, station, status…" value={wlFilter} onChange={(e) => setWlFilter(e.target.value)} />
          </div>
        </div>
        <div className="sb-wl-filters">
          {[
            { key: "all", label: "All" },
            { key: "confirmed-1", label: "1 seat" },
            { key: "confirmed-2", label: "2 seats" },
            { key: "confirmed-3", label: "3 seats" },
            { key: "confirmed-4", label: "4 seats" },
            { key: "confirmed-5", label: "5 seats" },
            { key: "confirmed-6", label: "6 seats" },
            { key: "general-partial", label: "Partial + General" },
            { key: "general-full", label: "Full General" },
            { key: "waitlisted", label: "Still waitlisted" },
          ].map((f) => (
            <button
              key={f.key}
              className={`sb-chip ${wlSeatCountFilter === f.key ? "active" : ""}`}
              onClick={() => setWlSeatCountFilter(f.key)}
              disabled={f.key !== "all" && !filterCounts[f.key]}
            >
              {f.label} <span className="sb-chip-count">{f.key === "all" ? allWlRows.length : filterCounts[f.key] || 0}</span>
            </button>
          ))}
        </div>
        <div className="sb-table-wrap tall">
          <table className="sb-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Requested route</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {filteredWL.map((r: any) => {
                const meta = STATUS_META[r.status as keyof typeof STATUS_META];
                const Icon = meta.Icon;
                let detail = "—";
                if (r.status === "confirmed") detail = `${r.used.length} seat${r.used.length > 1 ? "s" : ""}: ${r.used.map((u) => u.uid).join(" → ")}`;
                if (r.status === "general-partial") {
                  const genHrs = STATIONS[r.to].hour - STATIONS[r.coveredTo].hour;
                  const pctGen = (genHrs / (STATIONS[r.to].hour - STATIONS[r.from].hour)) * 100;
                  detail = `${r.used.length} seat${r.used.length > 1 ? "s" : ""} reserved, then ${hrs(genHrs)} (${pct(pctGen)} of trip) in General`;
                }
                if (r.status === "general-full") detail = "Entire journey in General class";
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{stCode(r.from)} → {stCode(r.to)}</td>
                    <td>
                      <span className="sb-status" style={{ color: meta.color }}>
                        <Icon size={14} /> {meta.label}
                      </span>
                    </td>
                    <td className="sb-detail">{detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="sb-footer">
        All station names, seat data and passenger records on this page are synthetically generated for
        demonstration purposes only and are not sourced from IRCTC. Fares are illustrative placeholders.
      </footer>
    </div>
  );
}

/* ----------------------------------------------------------------------
   SMALL PRESENTATIONAL PIECES
---------------------------------------------------------------------- */

interface BoardFieldProps {
  label: string;
  value: string;
  flip?: boolean;
}
function BoardField({ label, value, flip = false }: BoardFieldProps) {
  return (
    <div className="sb-board-field">
      <div className="sb-board-label">{label}</div>
      <div className={`sb-board-value ${flip ? "flip" : ""}`}>{value}</div>
    </div>
  );
}


interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub: string;
  delta?: number | null;
}
function MetricCard({ icon, label, value, sub, delta = null }: MetricCardProps) {
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
.sb-card-title { font-size: 15.5px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
.sb-scenario-tag { font-size: 11px; font-weight: 700; color: var(--accent2); background: rgba(108,141,250,0.12); border: 1px solid rgba(108,141,250,0.3); padding: 3px 9px; border-radius: 20px; letter-spacing: .4px; }
.sb-card-title.small { font-size: 13.5px; color: var(--muted); font-weight: 600; }
.sb-card-title-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.sb-card-note { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
.sb-card-note b { color: var(--text); }

.sb-tabs { display: flex; gap: 6px; }
.sb-tab { background: var(--panel2); border: 1px solid var(--line); color: var(--muted); padding: 6px 12px; border-radius: 20px; font-size: 12.5px; cursor: pointer; }
.sb-tab.active { background: var(--accent2); border-color: var(--accent2); color: #06101f; font-weight: 700; }

.sb-heatmap { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.sb-coach-block { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.sb-coach-label { width: 32px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 700; color: var(--muted); flex-shrink: 0; padding-top: 5px; }
.sb-coach-grid { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
.sb-seat { 
  width: 26px; height: 26px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.04); 
  display: flex; align-items: center; justify-content: center;
  font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; font-weight: 700; color: #06101f;
  cursor: pointer; padding: 0; transition: all .15s ease;
}
.sb-seat:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 4px 10px rgba(0,0,0,0.4); z-index: 2; position: relative; }
.sb-seat.selected { outline: 2px solid var(--accent2); outline-offset: 2px; }
.sb-seat.free { background: var(--ok); }
.sb-seat.partial { background: var(--warn); }
.sb-seat.occupied { background: #2a3450; color: var(--muted); border-color: transparent; }

.sb-legend { display: flex; gap: 18px; margin-top: 12px; font-size: 12px; color: var(--muted); flex-wrap: wrap; align-items: center; }
.sb-legend-hint { font-style: italic; opacity: .8; }
.sb-dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.sb-dot.free { background: var(--ok); }
.sb-dot.partial { background: var(--warn); }
.sb-dot.occupied { background: #2a3450; }

.sb-inspector { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-top: 14px; }
.sb-inspector.empty { color: var(--muted); font-size: 13px; text-align: center; padding: 18px; }
.sb-inspector-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 13.5px; font-weight: 700; }
.sb-inspector-sub { color: var(--muted); font-weight: 500; font-size: 12.5px; }
.sb-chip-close { margin-left: auto; background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
.sb-chip-close:hover { color: var(--text); }
.sb-timeline { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.sb-timeline-seg { padding: 6px 10px; border-radius: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; }
.sb-timeline-seg.free { background: rgba(52,211,153,0.15); color: var(--ok); border: 1px solid rgba(52,211,153,0.35); }
.sb-timeline-seg.occupied { background: rgba(139,150,179,0.1); color: var(--muted); border: 1px solid var(--line); }
.sb-inspector-legend { display: flex; gap: 18px; font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }

.sb-wl-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; margin-bottom: 4px; }
.sb-chip {
  background: var(--panel2); border: 1px solid var(--line); color: var(--muted);
  padding: 5px 10px; border-radius: 20px; font-size: 11.5px; cursor: pointer; display: flex; align-items: center; gap: 5px;
}
.sb-chip:disabled { opacity: .35; cursor: not-allowed; }
.sb-chip.active { background: var(--accent2); border-color: var(--accent2); color: #06101f; font-weight: 700; }
.sb-chip-count { font-family: 'IBM Plex Mono', monospace; opacity: .8; }
.sb-chip.active .sb-chip-count { opacity: 1; }

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
`;
