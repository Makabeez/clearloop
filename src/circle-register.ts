// Generate and register a Circle entity secret. Run this ONCE, before circle:setup.
//
//   CIRCLE_API_KEY=... npm run circle:register
//
// What it does:
//   1. generates a 32-byte entity secret
//   2. registers its ciphertext with Circle (this is what authorises signing)
//   3. writes a recovery file you must keep OUTSIDE the repo
//
// Then paste the printed CIRCLE_ENTITY_SECRET into .env and run `npm run circle:setup`.
//
// The entity secret is the key that unlocks every wallet in your account. Never
// commit it, never paste it anywhere, and keep the recovery file somewhere safe —
// losing it means losing access to the wallets.

import {
  generateEntitySecret,
  registerEntitySecretCiphertext,
} from "@circle-fin/developer-controlled-wallets";

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    console.error("\n  Set CIRCLE_API_KEY first (console.circle.com → API keys).\n");
    process.exit(1);
  }

  if (process.env.CIRCLE_ENTITY_SECRET) {
    console.log(
      "\n  CIRCLE_ENTITY_SECRET is already set in your environment." +
        "\n  If it is already registered, skip this and run `npm run circle:setup`." +
        "\n  Re-registering a NEW secret invalidates the old one.\n",
    );
  }

  // Prints a fresh 32-byte hex secret to stdout.
  console.log("\n  Generating entity secret…\n");
  generateEntitySecret();
  console.log(
    "\n  ^ copy the hex value above — that is your CIRCLE_ENTITY_SECRET.\n" +
      "  Add it to .env, then re-run this command to register it:\n" +
      "      CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=<the hex> npm run circle:register\n",
  );

  const secret = process.env.CIRCLE_ENTITY_SECRET;
  if (!secret) return;

  console.log("  Registering ciphertext with Circle…");
  const recoveryFileDownloadPath = process.env.CIRCLE_RECOVERY_PATH ?? "../circle-recovery-file.json";
  await registerEntitySecretCiphertext({
    apiKey,
    entitySecret: secret,
    recoveryFileDownloadPath,
  });
  console.log(`  registered. recovery file → ${recoveryFileDownloadPath}`);
  console.log("  (kept outside the repo on purpose — do not commit it)\n");
  console.log("  Next: npm run circle:setup\n");
}

main().catch((e) => {
  console.error("\n  Registration failed:", e?.message ?? e, "\n");
  process.exit(1);
});
