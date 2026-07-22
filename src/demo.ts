// Standalone demo: generate a dense agent obligation graph, net it, and print the
// headline number your pitch leads with. Runs with no chain/RPC — `npm run demo`.

import { netGraph, usdc, type Obligation } from "./netting.js";

const U = 1_000_000n;
const N = Number(process.env.AGENTS ?? 15);
const EDGES = Number(process.env.EDGES ?? 200);

const agents = Array.from({ length: N }, (_, i) => `agent-${String(i).padStart(2, "0")}`);

let seed = Number(process.env.SEED ?? 1337);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const obs: Obligation[] = [];
for (let k = 0; k < EDGES; k++) {
  const a = agents[Math.floor(rnd() * N)];
  let b = agents[Math.floor(rnd() * N)];
  if (a === b) b = agents[(agents.indexOf(a) + 1) % N];
  const amount = BigInt(1 + Math.floor(rnd() * 100)) * U;
  obs.push({ debtor: a, creditor: b, amount, nonce: BigInt(k), epochId: 1n });
}

const r = netGraph(obs);

console.log("\n  Clearloop — multilateral clearing\n");
console.log(`  agents ................ ${N}`);
console.log(`  obligations ........... ${obs.length}`);
console.log(`  gross volume .......... ${usdc(r.gross)}`);
console.log(`  net volume moved ...... ${usdc(r.netVolume)}`);
console.log(`  settlements ........... ${r.settlements.length}   (vs ${obs.length} gross payments)`);
console.log(`  capital freed ......... ${(r.capitalFreedBps / 100).toFixed(1)}%\n`);

console.log("  net position per agent (top movers):");
[...r.positions.entries()]
  .sort((a, b) => (b[1] < 0n ? -b[1] : b[1]) > (a[1] < 0n ? -a[1] : a[1]) ? 1 : -1)
  .slice(0, 6)
  .forEach(([a, v]) => console.log(`    ${a}  ${v >= 0n ? "+" : ""}${usdc(v)}`));
console.log("");
