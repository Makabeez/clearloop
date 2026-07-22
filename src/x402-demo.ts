// Agents as an economy: each runs a paywalled service AND buys from the others over
// x402. Every purchase is a signed obligation; Clearloop nets the whole graph.
//
//   npm run x402
//
// RPC-free (signs against the ClearingHouse address for domain separation, but does
// not submit) — the same obligations settle on Arc via `npm run e2e`.

import { parseUnits, type Address } from "viem";
import { Agent } from "./agent.js";
import { SellerAgent, pay } from "./x402-agent.js";
import { netGraph, usdc, type Obligation } from "./netting.js";
import type { SignedObligation } from "./obligation.js";

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 5042002);
const CH = (process.env.CLEARINGHOUSE_ADDRESS ??
  "0x93b937497F55eD6e55A986217f193Dc4daa10D6E") as Address;
const EPOCH = BigInt(process.env.EPOCH ?? 7);
const U = (n: string) => parseUnits(n, 6);

// anvil-style deterministic keys (demo only)
const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

async function main() {
  const alice = new Agent(KEYS[0], "Alice");
  const bob = new Agent(KEYS[1], "Bob");
  const carol = new Agent(KEYS[2], "Carol");

  // Each agent sells a service at its own price.
  const pool: SignedObligation[] = [];
  const record = (ob: SignedObligation) => pool.push(ob);
  const common = { chainId: CHAIN_ID, clearingHouse: CH, onObligation: record };

  const sellers = [
    new SellerAgent({ agent: alice, port: 4001, price: U("2"), ...common }),   // risk-score
    new SellerAgent({ agent: bob, port: 4002, price: U("1.5"), ...common }),    // price-feed
    new SellerAgent({ agent: carol, port: 4003, price: U("3"), ...common }),    // compute
  ];
  await Promise.all(sellers.map((s) => s.start()));
  const url = { Alice: sellers[0].url, Bob: sellers[1].url, Carol: sellers[2].url };

  console.log(`\n  Clearloop x402 — agents paying agents\n`);
  console.log(`  chain ${CHAIN_ID} · ClearingHouse ${CH.slice(0, 10)}…\n`);

  // A mesh of autonomous cross-purchases (buyer, seller, resource).
  const trades: Array<[Agent, string, keyof typeof url, string]> = [
    [alice, "price-feed", "Bob", "risk-model needs a quote"],
    [alice, "compute", "Carol", "run an embedding job"],
    [bob, "risk-score", "Alice", "score a counterparty"],
    [bob, "compute", "Carol", "batch inference"],
    [carol, "risk-score", "Alice", "screen a wallet"],
    [carol, "price-feed", "Bob", "mark to market"],
    [alice, "compute", "Carol", "second embedding job"],
  ];

  const nonce = new Map<string, bigint>();
  for (const [buyer, resource, sellerName, why] of trades) {
    const n = nonce.get(buyer.name) ?? 0n;
    nonce.set(buyer.name, n + 1n);
    const { response, obligation } = await pay({
      buyer, sellerUrl: url[sellerName], resource, nonce: n, epochId: EPOCH,
      chainId: CHAIN_ID, clearingHouse: CH,
    });
    console.log(
      `  ${buyer.name} → ${sellerName.padEnd(5)} ${usdc(obligation.amount).padStart(6)}  ${resource.padEnd(11)} (${why})`,
    );
    void response;
  }

  await Promise.all(sellers.map((s) => s.stop()));

  // Clear the whole graph.
  const g = netGraph(pool as Obligation[]);
  console.log(`\n  ── clearing epoch ${EPOCH} ──`);
  console.log(`  purchases ......... ${pool.length}`);
  console.log(`  gross volume ...... ${usdc(g.gross)}`);
  console.log(`  net moved ......... ${usdc(g.netVolume)}`);
  console.log(`  settlements ....... ${g.settlements.length}`);
  console.log(`  capital freed ..... ${(g.capitalFreedBps / 100).toFixed(1)}%\n`);
  console.log(`  net positions:`);
  for (const [addr, net] of g.positions) {
    const name = addr === alice.address ? "Alice" : addr === bob.address ? "Bob" : "Carol";
    console.log(`    ${name.padEnd(6)} ${net >= 0n ? "+" : ""}${usdc(net)}`);
  }
  console.log(`\n  → these ${pool.length} signed obligations settle on Arc via \`npm run e2e\`.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
