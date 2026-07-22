// x402 payment layer for Clearloop.
//
// x402 (HTTP 402) is a negotiation standard: a seller answers a request with the
// schemes it accepts, and the buyer picks one and returns a signed payment payload.
// Circle Nanopayments ships the `GatewayWalletBatched` scheme — an EIP-3009
// TransferWithAuthorization signed against the GatewayWallet contract, which Circle
// Gateway then batches on the BUYER side.
//
// Clearloop registers a sibling scheme, `clearloop-exact`: the same x402 negotiation
// and the same EIP-712 authorization primitive, but the payload is a Clearloop
// obligation signed against the ClearingHouse. Instead of buyer-side batching, these
// obligations flow into the coordinator and clear MULTILATERALLY across the whole
// agent graph. Same rail family as Nanopayments — one layer up.

import { Buffer } from "node:buffer";
import { recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import { OBLIGATION_TYPES, clearloopDomain } from "./obligation.js";
import type { Obligation } from "./netting.js";

export const SCHEME = "clearloop-exact";
export const X402_VERSION = 2;

/** Sent by the seller in the 402 response (base64-encoded in the PAYMENT-REQUIRED header). */
export interface PaymentRequired {
  x402Version: number;
  scheme: string;
  network: string;
  resource: string; // what's being bought
  maxAmountRequired: string; // USDC base units, as string
  payTo: Address; // seller (creditor)
  verifyingContract: Address; // ClearingHouse — obligations are signed against it
  chainId: number;
}

/** Sent by the buyer on retry (base64-encoded in the Payment-Signature header). */
export interface PaymentPayload {
  scheme: string;
  obligation: {
    debtor: Address;
    creditor: Address;
    amount: string;
    nonce: string;
    epochId: string;
  };
  signature: Hex;
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const dec = <T>(s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;

export const encodePaymentRequired = (p: PaymentRequired) => enc(p);
export const decodePaymentRequired = (s: string) => dec<PaymentRequired>(s);
export const encodePaymentPayload = (p: PaymentPayload) => enc(p);
export const decodePaymentPayload = (s: string) => dec<PaymentPayload>(s);

export function toObligation(p: PaymentPayload, epochFallback: bigint): Obligation & { signature: Hex } {
  const o = p.obligation;
  return {
    debtor: o.debtor,
    creditor: o.creditor,
    amount: BigInt(o.amount),
    nonce: BigInt(o.nonce),
    epochId: BigInt(o.epochId ?? epochFallback),
    signature: p.signature,
  };
}

/**
 * Verify a buyer's payment payload: the signature must recover to the debtor, the
 * creditor must be the seller, and the amount must cover the price. Returns the
 * verified obligation (ready to hand to the coordinator) or throws.
 */
export async function verifyPayment(
  payload: PaymentPayload,
  opts: { chainId: number; clearingHouse: Address; payTo: Address; price: bigint },
): Promise<Obligation & { signature: Hex }> {
  if (payload.scheme !== SCHEME) throw new Error(`unsupported scheme ${payload.scheme}`);
  const ob = toObligation(payload, 0n);

  if (ob.creditor.toLowerCase() !== opts.payTo.toLowerCase()) throw new Error("wrong payTo");
  if (ob.amount < opts.price) throw new Error("underpaid");

  const signer = await recoverTypedDataAddress({
    domain: clearloopDomain(opts.chainId, opts.clearingHouse),
    types: OBLIGATION_TYPES,
    primaryType: "Obligation",
    message: {
      debtor: ob.debtor,
      creditor: ob.creditor,
      amount: ob.amount,
      nonce: ob.nonce,
      epochId: ob.epochId,
    },
    signature: ob.signature,
  });
  if (signer.toLowerCase() !== ob.debtor.toLowerCase()) throw new Error("bad signature");
  return ob;
}
