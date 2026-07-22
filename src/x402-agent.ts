// A seller agent exposes paywalled resources over HTTP; a buyer runs the x402 flow
// to pay for them. Every settled purchase is a signed Clearloop obligation.

import { createServer, type Server } from "node:http";
import type { Address, Hex } from "viem";
import { Agent } from "./agent.js";
import { signObligationLocal, type SignedObligation } from "./obligation.js";
import {
  SCHEME, X402_VERSION, encodePaymentRequired, decodePaymentPayload, verifyPayment,
  type PaymentPayload, type PaymentRequired,
} from "./x402.js";

export interface SellerConfig {
  agent: Agent;
  port: number;
  chainId: number;
  clearingHouse: Address;
  network?: string;
  price: bigint; // USDC base units per call
  onObligation: (ob: SignedObligation) => void;
}

/** Paywalled service. GET /<resource> → 402 with payment terms; retry with a signed payload → 200. */
export class SellerAgent {
  private server?: Server;
  constructor(private cfg: SellerConfig) {}

  get url() { return `http://127.0.0.1:${this.cfg.port}`; }

  start(): Promise<void> {
    const { agent, chainId, clearingHouse, price, network = "arc-testnet", onObligation } = this.cfg;
    this.server = createServer(async (req, res) => {
      const resource = (req.url ?? "/").replace(/^\//, "") || "resource";
      const sigHeader = req.headers["payment-signature"] as string | undefined;

      // No payment yet → answer 402 with the terms.
      if (!sigHeader) {
        const required: PaymentRequired = {
          x402Version: X402_VERSION, scheme: SCHEME, network, resource,
          maxAmountRequired: price.toString(), payTo: agent.address as Address,
          verifyingContract: clearingHouse, chainId,
        };
        res.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequired(required),
        });
        return res.end(JSON.stringify({ error: "payment required", scheme: SCHEME }));
      }

      // Payment present → verify and serve.
      try {
        const payload = decodePaymentPayload(sigHeader) as PaymentPayload;
        const ob = await verifyPayment(payload, {
          chainId, clearingHouse, payTo: agent.address as Address, price,
        });
        onObligation(ob as SignedObligation);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ resource, servedBy: agent.name, data: sample(resource) }));
      } catch (e: any) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e?.message ?? "payment invalid" }));
      }
    });
    return new Promise((resolve) => this.server!.listen(this.cfg.port, () => resolve()));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

function sample(resource: string) {
  const bank: Record<string, unknown> = {
    "risk-score": { score: 87, level: "high" },
    "price-feed": { pair: "USDC/USD", px: 1.0001 },
    compute: { job: "embed", tokens: 512 },
  };
  return bank[resource] ?? { ok: true };
}

/**
 * Buyer side: call a seller, handle the 402, sign a Clearloop obligation, retry, and
 * return the resource plus the obligation created. Mirrors GatewayClient.pay().
 */
export async function pay(opts: {
  buyer: Agent;
  sellerUrl: string;
  resource: string;
  nonce: bigint;
  epochId: bigint;
  chainId: number;
  clearingHouse: Address;
}): Promise<{ response: any; obligation: SignedObligation }> {
  const { buyer, sellerUrl, resource, nonce, epochId, chainId, clearingHouse } = opts;
  const url = `${sellerUrl}/${resource}`;

  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const req = JSON.parse(
    Buffer.from(first.headers.get("payment-required")!, "base64").toString("utf8"),
  ) as PaymentRequired;

  const ob = {
    debtor: buyer.address as Address,
    creditor: req.payTo,
    amount: BigInt(req.maxAmountRequired),
    nonce,
    epochId,
  };
  const signature: Hex = await signObligationLocal(buyer.account, chainId, clearingHouse, ob);

  const payload: PaymentPayload = {
    scheme: SCHEME,
    obligation: {
      debtor: ob.debtor, creditor: ob.creditor, amount: ob.amount.toString(),
      nonce: ob.nonce.toString(), epochId: ob.epochId.toString(),
    },
    signature,
  };

  const paid = await fetch(url, {
    headers: { "Payment-Signature": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
  if (paid.status !== 200) throw new Error(`payment rejected: ${(await paid.json() as any).error}`);

  return { response: await paid.json(), obligation: { ...ob, signature } };
}
