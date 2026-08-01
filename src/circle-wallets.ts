// Circle Developer-Controlled Wallets integration.
//
// Agents hold real Circle wallets on Arc testnet and sign their Clearloop
// obligations through Circle's signTypedData endpoint — no private key ever exists
// in the agent process. Circle custodies the key material behind an entity secret;
// the agent only asks for a signature.
//
// Account type is EOA on purpose: an EOA signature is plain ECDSA, so
// ClearingHouse.settleEpoch's ecrecover verifies it with no contract changes.
// (An SCA would need EIP-1271 support in the contract.)

import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import type { Obligation } from "./netting.js";
import type { SignedObligation } from "./obligation.js";

export const ARC_TESTNET = "ARC-TESTNET" as const;

export function circleClient(): CircleDeveloperControlledWalletsClient {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error(
      "Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET. Get an API key at console.circle.com, " +
        "then run `npm run circle:setup` (see README → Circle Wallets).",
    );
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

/**
 * The exact EIP-712 payload Circle expects. Mirrors ClearingHouse's
 * OBLIGATION_TYPEHASH and DOMAIN_SEPARATOR, so a Circle-produced signature
 * verifies on-chain unchanged.
 */
export function obligationTypedData(
  ob: Obligation,
  chainId: number,
  verifyingContract: Address,
) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Obligation: [
        { name: "debtor", type: "address" },
        { name: "creditor", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "epochId", type: "uint256" },
      ],
    },
    domain: { name: "Clearloop", version: "1", chainId, verifyingContract },
    primaryType: "Obligation",
    message: {
      debtor: ob.debtor,
      creditor: ob.creditor,
      amount: ob.amount.toString(),
      nonce: ob.nonce.toString(),
      epochId: ob.epochId.toString(),
    },
  };
}

export interface CircleWallet {
  name: string;
  walletId: string;
  address: Address;
}

/** Create a wallet set plus one Arc-testnet EOA wallet per agent name. */
export async function createAgentWallets(
  client: CircleDeveloperControlledWalletsClient,
  names: string[],
  walletSetName = "Clearloop agents",
): Promise<{ walletSetId: string; wallets: CircleWallet[] }> {
  const set = await client.createWalletSet({ name: walletSetName });
  const walletSetId = set.data?.walletSet?.id;
  if (!walletSetId) throw new Error("createWalletSet returned no id");

  const created = await client.createWallets({
    walletSetId,
    blockchains: [ARC_TESTNET as never],
    accountType: "EOA",
    count: names.length,
    metadata: names.map((n) => ({ name: n })),
  });

  const list = created.data?.wallets ?? [];
  if (list.length < names.length) {
    throw new Error(`expected ${names.length} wallets, got ${list.length}`);
  }
  return {
    walletSetId,
    wallets: list.map((w, i) => ({
      name: names[i],
      walletId: w.id,
      address: w.address as Address,
    })),
  };
}

/**
 * An agent whose key lives in Circle's custody. Same `issue()` shape as the
 * local Agent, so the coordinator and netting engine are unchanged.
 */
export class CircleAgent {
  constructor(
    private client: CircleDeveloperControlledWalletsClient,
    readonly wallet: CircleWallet,
  ) {}

  get name() {
    return this.wallet.name;
  }
  get address(): Address {
    return this.wallet.address;
  }

  async issue(
    creditor: Address,
    amount: bigint,
    nonce: bigint,
    epochId: bigint,
    chainId: number,
    clearingHouse: Address,
  ): Promise<SignedObligation> {
    const ob: Obligation = {
      debtor: this.address,
      creditor,
      amount,
      nonce,
      epochId,
    };
    const typed = obligationTypedData(ob, chainId, clearingHouse);

    const res = await this.client.signTypedData({
      walletId: this.wallet.walletId,
      data: JSON.stringify(typed),
    });
    const signature = res.data?.signature as Hex | undefined;
    if (!signature) throw new Error(`Circle returned no signature for ${this.name}`);

    // Fail loudly here rather than with an opaque revert inside settleEpoch.
    const recovered = await recoverTypedDataAddress({
      domain: typed.domain,
      types: { Obligation: typed.types.Obligation },
      primaryType: "Obligation",
      message: typed.message,
      signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    if (recovered.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(
        `Circle signature for ${this.name} recovers to ${recovered}, expected ${this.address}`,
      );
    }

    return { ...ob, signature };
  }
}

/** USDC balance of a Circle wallet, as reported by Circle. */
export async function walletUsdc(
  client: CircleDeveloperControlledWalletsClient,
  walletId: string,
): Promise<string> {
  const res = await client.getWalletTokenBalance({ id: walletId });
  const usdc = res.data?.tokenBalances?.find(
    (b) => b.token?.symbol?.toUpperCase() === "USDC",
  );
  return usdc?.amount ?? "0";
}

/**
 * Execute a contract call from a Circle-custodied wallet and wait for confirmation.
 *
 * Circle submits and signs the transaction; nothing here ever sees a private key.
 * Polls until the transaction is CONFIRMED/COMPLETE (or throws on FAILED), because
 * the next step usually depends on the state change having landed.
 */
export async function circleExecute(
  client: CircleDeveloperControlledWalletsClient,
  walletId: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: unknown[],
  timeoutMs = 90_000,
): Promise<string> {
  const created = await client.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters: abiParameters as never,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } } as never,
  });

  const id = created.data?.id;
  if (!id) throw new Error(`Circle returned no transaction id for ${abiFunctionSignature}`);

  const deadline = Date.now() + timeoutMs;
  let state = created.data?.state ?? "INITIATED";
  while (Date.now() < deadline) {
    if (state === "CONFIRMED" || state === "COMPLETE") return id;
    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      throw new Error(`Circle tx ${state} for ${abiFunctionSignature}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const got = await client.getTransaction({ id });
    state = got.data?.transaction?.state ?? state;
  }
  throw new Error(`Circle tx timed out in state ${state} for ${abiFunctionSignature}`);
}
