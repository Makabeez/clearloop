// Agents holding real Circle Developer-Controlled Wallets sign their obligations
// through Circle, then Clearloop nets the graph and settles once on Arc.
//
//   npm run circle:demo
//
// No private key exists anywhere in this process — Circle custodies the key
// material and returns signatures. The EIP-712 signature it produces is verified
// on-chain by ClearingHouse.settleEpoch exactly like a locally-signed one.

import { parseUnits, type Address } from "viem";
import { publicClient, wallet, CHAIN_ID, txLink } from "./chain.js";
import { clearingHouseArtifact } from "./artifacts.js";
import {
  circleClient,
  CircleAgent,
  walletUsdc,
  circleExecute,
  type CircleWallet,
} from "./circle-wallets.js";
import { runEpoch } from "./coordinator.js";
import { usdc } from "./netting.js";
import type { SignedObligation } from "./obligation.js";

const U = (n: string) => parseUnits(n, 6);

function loadWallets(): CircleWallet[] {
  const ids = (process.env.CIRCLE_WALLET_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const addrs = (process.env.CIRCLE_WALLET_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const names = (process.env.CIRCLE_AGENT_NAMES ?? "Alice,Bob,Carol").split(",").map((s) => s.trim());
  if (ids.length < 3 || addrs.length < 3) {
    throw new Error(
      "Need CIRCLE_WALLET_IDS and CIRCLE_WALLET_ADDRESSES (3 each) in .env — run `npm run circle:setup` first.",
    );
  }
  return ids.map((id, i) => ({ name: names[i] ?? `agent${i}`, walletId: id, address: addrs[i] as Address }));
}

async function main() {
  const client = circleClient();
  const chArt = clearingHouseArtifact();
  const chAddr = process.env.CLEARINGHOUSE_ADDRESS as Address;
  if (!chAddr) throw new Error("Set CLEARINGHOUSE_ADDRESS in .env");

  const agents = loadWallets().map((w) => new CircleAgent(client, w));
  const [alice, bob, carol] = agents;
  const epochId = BigInt(process.env.EPOCH ?? 20);

  console.log(`\n  Clearloop × Circle Wallets — chain ${CHAIN_ID}`);
  console.log(`  ClearingHouse ${chAddr}\n`);
  console.log(`  agents hold Circle Developer-Controlled Wallets (no local keys):`);
  for (const a of agents) {
    const bal = await walletUsdc(client, a.wallet.walletId);
    console.log(`    ${a.name.padEnd(6)} ${a.address}   ${bal} USDC`);
  }

  // --- collateral: each agent deposits into the ClearingHouse, through Circle ----
  // The agents' USDC lives in Circle-custodied wallets, so the approve + deposit
  // calls go through Circle's contract-execution API too. Still no local key.
  const usdcAddr = (process.env.USDC_ADDRESS ??
    "0x3600000000000000000000000000000000000000") as Address;
  const need = U(process.env.CIRCLE_DEPOSIT ?? "5");

  console.log(`\n  posting collateral through Circle…`);
  for (const a of agents) {
    const held = (await publicClient.readContract({
      address: chAddr, abi: chArt.abi, functionName: "balance", args: [a.address],
    })) as bigint;
    if (held >= need) {
      console.log(`    ${a.name.padEnd(6)} already posted ${usdc(held)}`);
      continue;
    }
    await circleExecute(client, a.wallet.walletId, usdcAddr,
      "approve(address,uint256)", [chAddr, need.toString()]);
    await circleExecute(client, a.wallet.walletId, chAddr,
      "deposit(uint256)", [need.toString()]);
    const now = (await publicClient.readContract({
      address: chAddr, abi: chArt.abi, functionName: "balance", args: [a.address],
    })) as bigint;
    console.log(`    ${a.name.padEnd(6)} deposited ${usdc(now)}`);
  }

  // Each agent signs via Circle's signTypedData. Signatures are recovery-checked
  // inside CircleAgent.issue before we ever touch the chain.
  console.log(`\n  signing obligations through Circle…`);
  const obs: SignedObligation[] = [
    await alice.issue(bob.address, U("2"), 0n, epochId, CHAIN_ID, chAddr),
    await bob.issue(carol.address, U("2"), 0n, epochId, CHAIN_ID, chAddr),
    await carol.issue(alice.address, U("2"), 0n, epochId, CHAIN_ID, chAddr),
    await alice.issue(carol.address, U("1.25"), 1n, epochId, CHAIN_ID, chAddr),
    await carol.issue(bob.address, U("0.5"), 1n, epochId, CHAIN_ID, chAddr),
  ];
  console.log(`  ${obs.length} obligations signed by Circle, all signatures verified\n`);

  // The settler still submits the batch (it pays gas); the obligations are Circle's.
  const settler = wallet(process.env.DEPLOYER_KEY as `0x${string}`);
  const { hash, preview, batch } = await runEpoch({
    publicClient, settler, clearingHouse: chAddr, abi: chArt.abi, epochId, obligations: obs,
  });

  const b = batch!;
  console.log(`  ── epoch ${epochId} settled ──`);
  console.log(`  gross volume ...... ${usdc(b.grossVolume)}`);
  console.log(`  net moved ......... ${usdc(b.netVolume)}`);
  console.log(`  obligations ....... ${b.obligationCount}   →   settlements ${preview.settlements.length}`);
  console.log(`  capital freed ..... ${(Number(b.capitalFreedBps) / 100).toFixed(1)}%`);
  console.log(`  tx ................ ${txLink(hash)}\n`);
  console.log(`  Signed by Circle Wallets · netted by Clearloop · settled on Arc.\n`);
}

main().catch((e) => {
  console.error("\n  " + (e?.message ?? e) + "\n");
  process.exit(1);
});
