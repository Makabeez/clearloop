// Credit facility demo (anvil). Dave holds thin collateral but has a reputation-priced
// credit line. He net-debits beyond his balance; the shortfall is fronted from the house
// reserve as debt, and the creditors are still paid in full. Then Dave repays.
//
//   anvil    (one terminal)
//   npm run credit
//
// This is the DeFi-track story: intraday credit + a default waterfall, on top of
// multilateral clearing.

import { parseUnits, type Address, type Hex } from "viem";
import { publicClient, wallet, chain, CHAIN_ID } from "./chain.js";
import { clearingHouseArtifact, creditRegistryArtifact, mockUsdcArtifact } from "./artifacts.js";
import { Agent } from "./agent.js";
import { runEpoch } from "./coordinator.js";
import { usdc } from "./netting.js";
import type { SignedObligation } from "./obligation.js";

const ANVIL = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as Hex[];

const U = (n: string) => parseUnits(n, 6);

async function main() {
  const deployer = wallet(ANVIL[0]);
  const usdcArt = mockUsdcArtifact();
  const creditArt = creditRegistryArtifact();
  const chArt = clearingHouseArtifact();

  const alice = new Agent(ANVIL[1], "Alice");
  const bob = new Agent(ANVIL[2], "Bob");
  const carol = new Agent(ANVIL[3], "Carol");
  const dave = new Agent(ANVIL[4], "Dave");

  console.log(`\n  Clearloop — credit facility demo (chain ${CHAIN_ID})\n`);

  // deploy USDC + CreditRegistry + ClearingHouse
  const deploy = async (abi: any, bytecode: Hex, args: any[] = []) => {
    const h = await deployer.deployContract({ abi, bytecode, args, account: deployer.account!, chain });
    return (await publicClient.waitForTransactionReceipt({ hash: h })).contractAddress!;
  };
  const usdcAddr = await deploy(usdcArt.abi, usdcArt.bytecode);
  const creditAddr = await deploy(creditArt.abi, creditArt.bytecode);
  const chAddr = await deploy(chArt.abi, chArt.bytecode, [usdcAddr, creditAddr]);
  console.log(`  ClearingHouse ${chAddr}\n`);

  // helpers
  const mint = (to: Address, amt: bigint) =>
    deployer.writeContract({ address: usdcAddr, abi: usdcArt.abi, functionName: "mint", args: [to, amt], account: deployer.account!, chain });
  const readN = (fn: string, args: any[]) =>
    publicClient.readContract({ address: chAddr, abi: chArt.abi, functionName: fn, args }) as Promise<bigint>;

  const depositFor = async (a: Agent, amt: bigint) => {
    await mint(a.address as Address, amt);
    const w = wallet(a.pk);
    await w.writeContract({ address: usdcAddr, abi: usdcArt.abi, functionName: "approve", args: [chAddr, 2n ** 255n], account: w.account!, chain });
    const h = await w.writeContract({ address: chAddr, abi: chArt.abi, functionName: "deposit", args: [amt], account: w.account!, chain });
    await publicClient.waitForTransactionReceipt({ hash: h });
  };

  // Alice/Bob/Carol are well-collateralised; Dave is thin (only 10).
  await depositFor(alice, U("100"));
  await depositFor(bob, U("100"));
  await depositFor(carol, U("100"));
  await depositFor(dave, U("10"));
  console.log(`  deposits: Alice/Bob/Carol ${usdc(U("100"))} each · Dave ${usdc(U("10"))} (thin)`);

  // Dave earns a 100 USDC credit line (reputation score 750); house reserve funds it.
  await deployer.writeContract({ address: creditAddr, abi: creditArt.abi, functionName: "setLimit", args: [dave.address, U("100"), 750n], account: deployer.account!, chain });
  await mint(deployer.account!.address, U("100"));
  await deployer.writeContract({ address: usdcAddr, abi: usdcArt.abi, functionName: "approve", args: [chAddr, U("100")], account: deployer.account!, chain });
  const fh = await deployer.writeContract({ address: chAddr, abi: chArt.abi, functionName: "fundReserve", args: [U("100")], account: deployer.account!, chain });
  await publicClient.waitForTransactionReceipt({ hash: fh });
  console.log(`  Dave credit line ${usdc(U("100"))} (score 750) · house reserve ${usdc(U("100"))}\n`);

  // Epoch: Dave net-debits 50 (> his 10 collateral). Mesh so others net out too.
  const epochId = 1n;
  const obs: SignedObligation[] = [
    await dave.issue(alice.address, U("50"), 0n, epochId, CHAIN_ID, chAddr),
    await alice.issue(bob.address, U("20"), 0n, epochId, CHAIN_ID, chAddr),
    await bob.issue(carol.address, U("10"), 0n, epochId, CHAIN_ID, chAddr),
  ];

  const { batch } = await runEpoch({
    publicClient, settler: deployer, clearingHouse: chAddr, abi: chArt.abi, epochId, obligations: obs,
  });
  const b = batch!;
  console.log(`  ── epoch ${epochId} settled ──`);
  console.log(`  gross ............. ${usdc(b.grossVolume)}`);
  console.log(`  net moved ......... ${usdc(b.netVolume)}`);
  console.log(`  credit drawn ...... ${usdc(b.creditDrawn)}   ← Dave cleared past his collateral`);
  console.log(`  capital freed ..... ${(Number(b.capitalFreedBps) / 100).toFixed(1)}%\n`);

  console.log(`  Dave collateral ... ${usdc(await readN("balance", [dave.address]))}`);
  console.log(`  Dave debt ......... ${usdc(await readN("debt", [dave.address]))}   (owed to the house)`);
  console.log(`  Alice paid full ... ${usdc(await readN("balance", [alice.address]))}   (creditor unaffected)`);
  console.log(`  house reserve ..... ${usdc(await readN("reserve", []))}\n`);

  // Dave repays his 40 debt.
  await mint(dave.address as Address, U("40"));
  const dw = wallet(dave.pk);
  await dw.writeContract({ address: usdcAddr, abi: usdcArt.abi, functionName: "approve", args: [chAddr, U("40")], account: dw.account!, chain });
  const rh = await dw.writeContract({ address: chAddr, abi: chArt.abi, functionName: "repay", args: [U("40")], account: dw.account!, chain });
  await publicClient.waitForTransactionReceipt({ hash: rh });
  console.log(`  → Dave repays. debt ${usdc(await readN("debt", [dave.address]))} · reserve back to ${usdc(await readN("reserve", []))}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
