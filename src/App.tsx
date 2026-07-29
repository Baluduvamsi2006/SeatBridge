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

export default function SeatBridge() {
  return (
    <div className="sb-root">
      <h1>SeatBridge constants and RNG</h1>
    </div>
  );
}