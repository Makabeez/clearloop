import { describe, it, expect } from "vitest";
import { netGraph, minimalTransfers, type Obligation } from "./netting.js";

const U = 1_000_000n;
const A = "0xA", B = "0xB", C = "0xC", D = "0xD";

function ob(debtor: string, creditor: string, amount: bigint, epochId = 1n): Obligation {
  return { debtor, creditor, amount, nonce: 0n, epochId };
}

describe("netGraph", () => {
  it("cyclic obligations net to zero movement", () => {
    // A→B→C→A, 30 each. Everyone's net is 0 -> nothing moves against 90 gross.
    const r = netGraph([ob(A, B, 30n * U), ob(B, C, 30n * U), ob(C, A, 30n * U)]);
    expect(r.gross).toBe(90n * U);
    expect(r.netVolume).toBe(0n);
    expect(r.capitalFreedBps).toBe(10_000); // 100%
    expect(r.settlements.length).toBe(0);
    for (const v of r.positions.values()) expect(v).toBe(0n);
  });

  it("bilateral offset moves only the difference", () => {
    // A owes B 50, B owes A 20 -> net A -30, B +30. 30 moves against 70 gross.
    const r = netGraph([ob(A, B, 50n * U), ob(B, A, 20n * U)]);
    expect(r.gross).toBe(70n * U);
    expect(r.netVolume).toBe(30n * U);
    expect(r.capitalFreedBps).toBe(5714); // (70-30)/70
    expect(r.positions.get(A)).toBe(-30n * U);
    expect(r.positions.get(B)).toBe(30n * U);
    expect(r.settlements).toEqual([{ from: A, to: B, amount: 30n * U }]);
  });

  it("positions always conserve (Σ == 0)", () => {
    const obs = [ob(A, B, 12n * U), ob(B, C, 7n * U), ob(C, D, 5n * U), ob(D, A, 9n * U), ob(A, C, 3n * U)];
    const r = netGraph(obs);
    let sum = 0n;
    for (const v of r.positions.values()) sum += v;
    expect(sum).toBe(0n);
  });

  it("minimal transfers move exactly netVolume and are at most n-1", () => {
    const obs = [ob(A, B, 12n * U), ob(B, C, 7n * U), ob(C, D, 5n * U), ob(D, A, 9n * U), ob(A, C, 3n * U)];
    const r = netGraph(obs);
    const moved = r.settlements.reduce((s, x) => s + x.amount, 0n);
    expect(moved).toBe(r.netVolume);
    expect(r.settlements.length).toBeLessThanOrEqual(r.members.length - 1);
  });

  it("dense random graph frees capital", () => {
    const agents = Array.from({ length: 12 }, (_, i) => "0x" + i);
    const obs: Obligation[] = [];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 120; k++) {
      const a = agents[Math.floor(rnd() * 12)];
      let b = agents[Math.floor(rnd() * 12)];
      if (a === b) b = agents[(agents.indexOf(a) + 1) % 12];
      obs.push(ob(a, b, BigInt(1 + Math.floor(rnd() * 50)) * U));
    }
    const r = netGraph(obs);
    expect(r.netVolume).toBeLessThan(r.gross);
    expect(r.capitalFreedBps).toBeGreaterThan(3000); // dense graphs routinely free >30%
  });
});
