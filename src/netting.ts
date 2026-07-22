// Multilateral netting engine.
// Mirrors ClearingHouse.settleEpoch: applying every obligation to a per-member
// running position yields each member's NET position across the whole graph.
// Only net debtors move liquidity — that is the capital-efficiency win over
// one-directional (per-payer) batching.

export type Address = `0x${string}` | string;

export interface Obligation {
  debtor: Address;
  creditor: Address;
  amount: bigint;
  nonce: bigint;
  epochId: bigint;
}

export interface Settlement {
  from: Address;
  to: Address;
  amount: bigint;
}

export interface NetResult {
  positions: Map<Address, bigint>; // net per member (Σ == 0)
  members: Address[];
  gross: bigint; // Σ of all obligation amounts
  netVolume: bigint; // liquidity that actually moves (Σ net debits == Σ net credits)
  capitalFreedBps: number; // (gross - netVolume) / gross, in basis points
  settlements: Settlement[]; // minimal debtor→creditor transfers realising the nets
}

export function netGraph(obligations: Obligation[]): NetResult {
  const positions = new Map<Address, bigint>();
  let gross = 0n;

  for (const o of obligations) {
    if (o.amount <= 0n) throw new Error("obligation amount must be positive");
    positions.set(o.debtor, (positions.get(o.debtor) ?? 0n) - o.amount);
    positions.set(o.creditor, (positions.get(o.creditor) ?? 0n) + o.amount);
    gross += o.amount;
  }

  let netVolume = 0n;
  for (const v of positions.values()) if (v < 0n) netVolume += -v;

  const members = [...positions.keys()];
  const settlements = minimalTransfers(positions);
  const capitalFreedBps = gross === 0n ? 0 : Number(((gross - netVolume) * 10_000n) / gross);

  return { positions, members, gross, netVolume, capitalFreedBps, settlements };
}

/**
 * Greedy minimal-transfer set: repeatedly match the largest net-debtor against
 * the largest net-creditor. Produces at most (n-1) transfers and moves exactly
 * `netVolume` in total. This is what a coordinator hands to settleEpoch.
 */
export function minimalTransfers(positions: Map<Address, bigint>): Settlement[] {
  const debtors: Array<{ a: Address; v: bigint }> = [];
  const creditors: Array<{ a: Address; v: bigint }> = [];
  for (const [a, v] of positions) {
    if (v < 0n) debtors.push({ a, v: -v });
    else if (v > 0n) creditors.push({ a, v });
  }
  const byVal = (x: { v: bigint }, y: { v: bigint }) => (y.v > x.v ? 1 : y.v < x.v ? -1 : 0);
  debtors.sort(byVal);
  creditors.sort(byVal);

  const out: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = debtors[i].v < creditors[j].v ? debtors[i].v : creditors[j].v;
    out.push({ from: debtors[i].a, to: creditors[j].a, amount: pay });
    debtors[i].v -= pay;
    creditors[j].v -= pay;
    if (debtors[i].v === 0n) i++;
    if (creditors[j].v === 0n) j++;
  }
  return out;
}

/** Format 6-decimal USDC bigint as a human string. */
export function usdc(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}$${whole}${frac ? "." + frac : ""}`;
}
