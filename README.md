# SeatBridge – Smart Rail Journey Allocator

> **Project Type:** Simulation / Data Visualization

SeatBridge is a modern web application that simulates and visualizes a **segment-covering allocator** for waitlisted rail journeys. It intelligently stitches together vacant seat fragments to confirm passengers who would otherwise remain waitlisted, maximizing train utilization and revenue.

---

## 📖 Table of Contents
- [Project Overview](#project-overview)
- [Business Context & Goals](#business-context-goals)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Simulation Engine](#simulation-engine)
- [UI / Component Library](#ui-component-library)
- [Getting Started (Local Development)](#getting-started-local-development)
- [License](#license)

---

## 🎯 Project Overview
SeatBridge is built with **React + TypeScript + Vite**. It runs entirely in the browser, featuring a deterministic simulation engine that dynamically assigns vacant seat fragments to waitlisted passengers based on a configurable **seat-change tolerance** constraint.

The UI follows a **premium dark-mode / glass-morphism** design, with interactive data visualizations (Recharts) and a live Coach Vacancy Explorer.

---

## 📚 Business Context & Goals
| Problem | SeatBridge Solution |
|---------|----------------------|
| **Fragmented Vacancies** | Consolidates disjointed vacant legs (e.g., A→B and B→C) to satisfy end-to-end waitlisted requests (A→C). |
| **Under-utilized Assets** | Maximizes train capacity utilization by dynamically assigning passengers to seats as they become free mid-journey. |
| **All-or-Nothing Booking** | Introduces a configurable "seat-change tolerance" to confirm passengers willing to switch seats during their trip. |
| **Low Visibility** | Provides an interactive heatmap and timeline inspector to visualize seat availability at a granular level. |

**Goal:** Provide an interactive tool to demonstrate the massive potential capacity and revenue gains of a segment-covering allocation strategy for rail operators.

---

## ✨ Key Features
| Area | Feature | Business Rule |
|------|---------|----------------|
| **Simulation Engine** | Greedy interval cover algorithm | Fills `[from, to)` using at most `k` free seat fragments. |
| **Control Panel** | Configurable seat-change tolerance (`k`) and General Class fallback toggle | Evaluates passenger willingness to switch seats or move to unreserved coaches. |
| **KPI Dashboard** | Live metrics for Confirmations, Extra Seat-Hours Utilized, and Estimated Extra Revenue | Updates instantly upon running the simulation. |
| **Compare Chart** | Premium stacked bar chart visualizing outcomes across different `k` values | Shows the trade-off between seat-change tolerance and waitlist clearance. |
| **Coach Explorer** | Interactive seat heatmap (Sleeper, AC 3 Tier, AC 2 Tier) | Seats are color-coded (Mostly Free, Fragment Free, Occupied). |
| **Timeline Inspector** | Clickable seats revealing a visual `from → to` booking timeline | Identifies exactly where a seat is occupied and where it is free. |
| **Waitlist Table** | Searchable and filterable passenger assignment results | Displays final status (Confirmed, Partial+General, Full General, Still Waitlisted). |

---

## 🛠️ Tech Stack
| Layer | Tech | Reason |
|-------|------|--------|
| **Framework** | **React + Vite** | Blazing fast local development and HMR |
| **Language** | **TypeScript** | End-to-end type safety and robust interfaces |
| **Visualization** | **Recharts** | Declarative, responsive, and customizable SVG charts |
| **Icons** | **Lucide React** | Clean, modern vector icons |
| **Styling** | **Vanilla CSS (Variables)** | Lightweight, zero-dependency premium dark-mode styling |
| **Data Generation** | **Mulberry32 PRNG** | Deterministic seeding ensures reproducible simulation runs |

---

## ⚙️ Simulation Engine
The core of SeatBridge is a client-side simulation engine designed to solve a constrained interval covering problem:

1. **Deterministic Seeding:** A pseudo-random number generator (`mulberry32`) synthesizes realistic train routes, intermediate hub demand, and seat vacancy fragments.
2. **Greedy Interval Cover:** For each waitlisted passenger, the algorithm attempts to cover their requested journey `[from, to)` by consuming at most `k + 1` available seat fragments from the pool.
3. **General Fallback:** If enabled, any portion of the journey that cannot be covered by a reserved seat is assigned to the General class.
4. **Metrics Aggregation:** The system calculates the newly filled capacity hours, estimated revenue, and waitlist clearance rates.

---

## 🎨 UI / Component Library
| Component | Description | Usage |
|-----------|-------------|-------|
| `MetricCard` | KPI card with icons and delta indicators | Stats Dashboard |
| `BarChart` | Premium rounded stacked bar chart with glassmorphism tooltips | Compare 0-5 Scenario Analysis |
| `CoachBlock` | Heatmap grid of interactive seat buttons | Vacancy Explorer |
| `TimelineSeg` | Color-coded `from → to` journey segment blocks | Seat Inspector |
| `FilterChip` | Interactive status counters | Waitlist Table Filtering |

---

## 🚀 Getting Started (Local Development)
1. **Clone the repo**
   ```bash
   git clone <repository-url>
   cd SeatBridge
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Start the dev server**
   ```bash
   npm run dev
   ```
   Visit <http://localhost:5173> to interact with the simulation.

4. **Type-checking (optional)**
   ```bash
   npx tsc --noEmit
   ```

---

## 📄 License
This project is released under the **MIT License**.
