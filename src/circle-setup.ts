// One-time setup: create a Circle wallet set and one Arc-testnet wallet per agent.
//
//   npm run circle:setup
//
// Prints the wallet ids/addresses to paste into .env. Run once, then fund each
// printed address from https://faucet.circle.com (Arc Testnet).

import { circleClient, createAgentWallets, ARC_TESTNET } from "./circle-wallets.js";

async function main() {
  const client = circleClient();
  const names = (process.env.CIRCLE_AGENT_NAMES ?? "Alice,Bob,Carol")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`\n  Creating ${names.length} Circle wallets on ${ARC_TESTNET}…\n`);
  const { walletSetId, wallets } = await createAgentWallets(client, names);

  console.log(`  wallet set: ${walletSetId}\n`);
  for (const w of wallets) {
    console.log(`  ${w.name.padEnd(6)} ${w.address}   id=${w.walletId}`);
  }

  console.log(`\n  Add these to .env:\n`);
  console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
  console.log(`CIRCLE_WALLET_IDS=${wallets.map((w) => w.walletId).join(",")}`);
  console.log(`CIRCLE_WALLET_ADDRESSES=${wallets.map((w) => w.address).join(",")}`);

  console.log(`\n  Then fund each address at https://faucet.circle.com (Arc Testnet),`);
  console.log(`  and run:  npm run circle:demo\n`);
}

main().catch((e) => {
  console.error("\n  " + (e?.message ?? e) + "\n");
  process.exit(1);
});
