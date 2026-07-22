// End-to-end clearing on a real chain.
//   Local (default): `anvil` in another terminal, then `npm run e2e` — deploys
//     MockUSDC + ClearingHouse, funds 3 agents, settles one epoch on-chain.
//   Arc: set RPC_URL, CHAIN_ID, EXPLORER_URL, USDC_ADDRESS, CLEARINGHOUSE_ADDRESS,
//     DEPLOYER_KEY, AGENT_KEYS in .env — same command, no code change.

import { parseUnits, type Address, type Hex } from "viem";
import { publicClient, wallet, chain, CHAIN_ID, txLink } from "./chain.js";
import { clearingHouseArtifact, creditRegistryArtifact, mockUsdcArtifact } from "./artifacts.js";
import { Agent } from "./agent.js";
import { runEpoch } from "./coordinator.js";
import { netGraph, usdc } from "./netting.js";
import type { SignedObligation } from "./obligation.js";

// anvil deterministic keys (accounts 0..3)
const ANVIL = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as Hex[];

// Base unit. Local default = 1 USDC (deposits 100). For Arc set AMOUNT_USDC=0.05
// so deposits are 5 USDC — within the 20-USDC/2h faucet limit.
const ONE = parseUnits(process.env.AMOUNT_USDC ?? "1", 6);
const START = 100n * ONE;

async function main() {
  const chArt = clearingHouseArtifact();
  const usdcArt = mockUsdcArtifact();

  const deployerPk = (process.env.DEPLOYER_KEY ?? ANVIL[0]) as Hex;
  const deployer = wallet(deployerPk);

  const agentKeys = (process.env.AGENT_KEYS?.split(",").map((s) => s.trim() as Hex) ??
    ANVIL.slice(1, 4)) as Hex[];
  const [alice, bob, carol] = [
    new Agent(agentKeys[0], "Alice"),
    new Agent(agentKeys[1], "Bob"),
    new Agent(agentKeys[2], "Carol"),
  ];
  const agents = [alice, bob, carol];

  let usdcAddr = process.env.USDC_ADDRESS as Address | undefined;
  let chAddr = process.env.CLEARINGHOUSE_ADDRESS as Address | undefined;
  const isLocal = !chAddr;

  console.log(`\n  Clearloop e2e — chain ${CHAIN_ID} @ ${process.env.RPC_URL ?? "anvil"}\n`);

  if (isLocal) {
    // Deploy MockUSDC + CreditRegistry + ClearingHouse
    if (!usdcAddr) {
      const h = await deployer.deployContract({
        abi: usdcArt.abi, bytecode: usdcArt.bytecode, account: deployer.account!, chain,
      });
      usdcAddr = (await publicClient.waitForTransactionReceipt({ hash: h })).contractAddress!;
    }
    const creditArt = creditRegistryArtifact();
    const hc = await deployer.deployContract({
      abi: creditArt.abi, bytecode: creditArt.bytecode, account: deployer.account!, chain,
    });
    const creditAddr = (await publicClient.waitForTransactionReceipt({ hash: hc })).contractAddress!;
    const h2 = await deployer.deployContract({
      abi: chArt.abi, bytecode: chArt.bytecode, args: [usdcAddr, creditAddr],
      account: deployer.account!, chain,
    });
    chAddr = (await publicClient.waitForTransactionReceipt({ hash: h2 })).contractAddress!;
    console.log(`  MockUSDC ......... ${usdcAddr}`);
    console.log(`  ClearingHouse .... ${chAddr}\n`);
  } else {
    console.log(`  Using deployed ClearingHouse .... ${chAddr}`);
    console.log(`  Using USDC ..................... ${usdcAddr}\n`);
  }

  // Fund + deposit for each agent. Local mode mints first; on Arc the agents
  // spend their own faucet USDC (fund each from https://faucet.circle.com).
  // IMPORTANT: await every receipt in sequence — on Arc, firing deposit before
  // approve is mined collides nonces and the deposit silently reverts.
  for (const a of agents) {
    const aw = wallet(a.pk);
    // Skip if this agent already holds enough collateral (cheap reruns).
    const held = (await publicClient.readContract({
      address: chAddr!, abi: chArt.abi, functionName: "balance", args: [a.address],
    })) as bigint;
    if (held >= START) {
      console.log(`  ${a.name.padEnd(6)} already funded ${usdc(held)}  (${a.address})`);
      continue;
    }
    if (isLocal) {
      const mh = await deployer.writeContract({
        address: usdcAddr!, abi: usdcArt.abi, functionName: "mint",
        args: [a.address, START], account: deployer.account!, chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: mh });
    }
    const ah = await aw.writeContract({
      address: usdcAddr!, abi: usdcArt.abi, functionName: "approve",
      args: [chAddr!, 2n ** 255n], account: aw.account!, chain,
    });
    const ar = await publicClient.waitForTransactionReceipt({ hash: ah });
    if (ar.status !== "success") throw new Error(`${a.name}: approve reverted (${a.address})`);

    const dh = await aw.writeContract({
      address: chAddr!, abi: chArt.abi, functionName: "deposit",
      args: [START], account: aw.account!, chain,
    });
    const dr = await publicClient.waitForTransactionReceipt({ hash: dh });
    if (dr.status !== "success") {
      throw new Error(`${a.name}: deposit reverted — is ${a.address} funded from the faucet?`);
    }
    console.log(`  ${a.name.padEnd(6)} deposited ${usdc(START)}  (${a.address})`);
  }

  // --- Build one epoch's obligation graph ---------------------------------
  const epochId = BigInt(process.env.EPOCH ?? 1);
  const obs: SignedObligation[] = [
    // a 3-way cycle that nets to zero...
    await alice.issue(bob.address, 40n * ONE, 0n, epochId, CHAIN_ID, chAddr!),
    await bob.issue(carol.address, 40n * ONE, 0n, epochId, CHAIN_ID, chAddr!),
    await carol.issue(alice.address, 40n * ONE, 0n, epochId, CHAIN_ID, chAddr!),
    // ...plus extra flows that leave small net positions
    await alice.issue(carol.address, 25n * ONE, 1n, epochId, CHAIN_ID, chAddr!),
    await carol.issue(bob.address, 10n * ONE, 1n, epochId, CHAIN_ID, chAddr!),
  ];

  // --- Preflight: every net-debtor must have collateral >= its net debit -----
  const pre = netGraph(obs);
  for (const [addr, net] of pre.positions) {
    if (net < 0n) {
      const bal = (await publicClient.readContract({
        address: chAddr!, abi: chArt.abi, functionName: "balance", args: [addr],
      })) as bigint;
      if (bal < -net) {
        throw new Error(
          `collateral short: ${addr} nets ${usdc(net)} but has only ${usdc(bal)} deposited. ` +
            `Increase AMOUNT_USDC deposit or fund/deposit more.`,
        );
      }
    }
  }

  // --- Settle on-chain -----------------------------------------------------
  const { hash, preview, batch } = await runEpoch({
    publicClient, settler: deployer, clearingHouse: chAddr!, abi: chArt.abi, epochId, obligations: obs,
  });

  const b = batch!;
  console.log(`\n  ── epoch ${epochId} settled ──`);
  console.log(`  gross volume ...... ${usdc(b.grossVolume)}`);
  console.log(`  net moved ......... ${usdc(b.netVolume)}`);
  console.log(`  obligations ....... ${b.obligationCount}   →   settlements ${preview.settlements.length}`);
  console.log(`  capital freed ..... ${(Number(b.capitalFreedBps) / 100).toFixed(1)}%`);
  console.log(`  tx ................ ${txLink(hash)}`);

  // --- Balances after ------------------------------------------------------
  console.log(`\n  cleared balances:`);
  for (const a of agents) {
    const bal = (await publicClient.readContract({
      address: chAddr!, abi: chArt.abi, functionName: "balance", args: [a.address],
    })) as bigint;
    console.log(`    ${a.name.padEnd(6)} ${usdc(bal)}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
