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

export default function SeatBridge() {
  return (
    <div className="sb-root">
      <h1>SeatBridge simulation engine</h1>
    </div>
  );
}