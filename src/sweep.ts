// Measured sensitivity of multilateral netting to graph shape.
//
//   npm run sweep            # table
//   npm run sweep -- --csv   # machine-readable
//
// Every headline number Clearloop quotes is a point on these curves. The point of
// this script is that they are MEASURED over a parameter sweep with a fixed seed,
// not picked from one flattering graph — including the regimes where netting
// provides no benefit at all.

import { netGraph, type Obligation } from "./netting.js";

const U = 1_000_000n;
const CSV = process.argv.includes("--csv");

// deterministic PRNG so every run reproduces exactly
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const amt = (r: () => number) => BigInt(1 + Math.floor(r() * 100)) * U;

/** Pure star: one payer, k sellers, no reciprocity. The worst case for netting. */
function star(k: number, seed = 1): Obligation[] {
  const r = rng(seed);
  return Array.from({ length: k }, (_, i) => ({
    debtor: "payer", creditor: `s${i}`, amount: amt(r), nonce: BigInt(i), epochId: 1n,
  }));
}

/** Chain / supply line: A→B→C→… Each middle agent both receives and pays. */
function chain(n: number, seed = 1): Obligation[] {
  const r = rng(seed);
  return Array.from({ length: n - 1 }, (_, i) => ({
    debtor: `a${i}`, creditor: `a${i + 1}`, amount: amt(r), nonce: BigInt(i), epochId: 1n,
  }));
}

/**
 * Mesh with a tunable hierarchy bias.
 *   bias = 1 → every edge flows "downhill" by agent index (a DAG: no cycles)
 *   bias = 0 → uniformly random pairs (maximum reciprocity)
 */
function mesh(n: number, edges: number, bias: number, seed = 1337): Obligation[] {
  const r = rng(seed);
  const obs: Obligation[] = [];
  for (let k = 0; k < edges; k++) {
    let i = Math.floor(r() * n);
    let j = Math.floor(r() * n);
    if (i === j) j = (j + 1) % n;
    if (r() < bias && i > j) [i, j] = [j, i]; // force downhill
    obs.push({ debtor: `a${i}`, creditor: `a${j}`, amount: amt(r), nonce: BigInt(k), epochId: 1n });
  }
  return obs;
}

interface Row { scenario: string; agents: number; obligations: number; grossUsd: number; netUsd: number; settlements: number; freedPct: number; }

function measure(scenario: string, obs: Obligation[]): Row {
  const g = netGraph(obs);
  return {
    scenario,
    agents: g.members.length,
    obligations: obs.length,
    grossUsd: Number(g.gross) / 1e6,
    netUsd: Number(g.netVolume) / 1e6,
    settlements: g.settlements.length,
    freedPct: g.capitalFreedBps / 100,
  };
}

/** Average over several seeds so a single lucky graph can't carry a claim. */
function measureAvg(scenario: string, build: (seed: number) => Obligation[], seeds = 12): Row {
  const rows = Array.from({ length: seeds }, (_, i) => measure(scenario, build(1000 + i * 77)));
  const mean = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  return {
    scenario,
    agents: Math.round(mean((r) => r.agents)),
    obligations: Math.round(mean((r) => r.obligations)),
    grossUsd: Math.round(mean((r) => r.grossUsd)),
    netUsd: Math.round(mean((r) => r.netUsd)),
    settlements: Math.round(mean((r) => r.settlements)),
    freedPct: Number(mean((r) => r.freedPct).toFixed(1)),
  };
}

const rows: Row[] = [];

// --- 1. the floor: a pure star has no receivables to offset ------------------
for (const k of [3, 10, 50]) rows.push(measure(`star · 1 payer → ${k} sellers`, star(k)));

// --- 2. a chain: every middle agent offsets ---------------------------------
for (const n of [3, 5, 20]) rows.push(measure(`chain · ${n} agents in series`, chain(n)));

// --- 3. hierarchy bias at fixed density (15 agents, 200 edges) --------------
for (const b of [1.0, 0.75, 0.5, 0.25, 0.0])
  rows.push(measureAvg(`mesh · bias ${b.toFixed(2)}`, (s) => mesh(15, 200, b, s)));

// --- 4. density sweep, uniform random pairs (15 agents) ---------------------
for (const e of [15, 30, 60, 120, 200, 400])
  rows.push(measureAvg(`mesh · ${e} obligations`, (s) => mesh(15, e, 0, s)));

// --- 5. agent-count sweep at ~13 obligations/agent --------------------------
for (const n of [4, 8, 15, 30, 60])
  rows.push(measureAvg(`mesh · ${n} agents`, (s) => mesh(n, n * 13, 0, s)));

if (CSV) {
  console.log("scenario,agents,obligations,gross_usd,net_usd,settlements,capital_freed_pct");
  for (const r of rows)
    console.log(`"${r.scenario}",${r.agents},${r.obligations},${r.grossUsd},${r.netUsd},${r.settlements},${r.freedPct}`);
} else {
  const pad = (s: string | number, n: number, left = false) =>
    left ? String(s).padStart(n) : String(s).padEnd(n);
  console.log("\n  Clearloop — measured sensitivity of netting to graph shape");
  console.log("  (12-seed average for mesh rows; fixed seeds, fully reproducible)\n");
  console.log(`  ${pad("scenario", 30)}${pad("agents", 8, true)}${pad("obs", 7, true)}${pad("gross", 9, true)}${pad("net", 9, true)}${pad("settl", 7, true)}${pad("freed", 9, true)}`);
  console.log(`  ${"-".repeat(79)}`);
  let last = "";
  for (const r of rows) {
    const group = r.scenario.split(" ")[0];
    if (last && group !== last) console.log("");
    last = group;
    console.log(
      `  ${pad(r.scenario, 30)}${pad(r.agents, 8, true)}${pad(r.obligations, 7, true)}${pad("$" + r.grossUsd, 9, true)}${pad("$" + r.netUsd, 9, true)}${pad(r.settlements, 7, true)}${pad(r.freedPct + "%", 9, true)}`,
    );
  }
  console.log("");
  console.log("  Read this as the honest bound: netting is worth exactly as much as the");
  console.log("  graph is reciprocal. A pure star frees 0% and batching beats us there.\n");
}
