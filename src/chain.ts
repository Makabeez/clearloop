import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// Local anvil defaults; override via .env for Arc (RPC_URL, CHAIN_ID, CHAIN_NAME, EXPLORER_URL).
export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
export const EXPLORER_URL = process.env.EXPLORER_URL ?? "";

export const chain = defineChain({
  id: CHAIN_ID,
  name: process.env.CHAIN_NAME ?? "local",
  nativeCurrency: { name: "Gas", symbol: process.env.GAS_SYMBOL ?? "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// Retry with backoff (public Arc RPC rate-limits hard) and poll receipts slowly.
const transport = () => http(RPC_URL, { retryCount: 8, retryDelay: 2500, timeout: 30_000 });

export const publicClient = createPublicClient({ chain, transport: transport(), pollingInterval: 8_000 });

export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain, transport: transport() });
}

export function txLink(hash: string): string {
  return EXPLORER_URL ? `${EXPLORER_URL.replace(/\/$/, "")}/tx/${hash}` : hash;
}
