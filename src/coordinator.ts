import { decodeEventLog } from "viem";
import type { Abi, Address, PublicClient, WalletClient } from "viem";
import { netGraph } from "./netting.js";
import type { SignedObligation } from "./obligation.js";

/** Every address that appears as debtor or creditor — the `members` array settleEpoch needs. */
export function membersOf(obs: SignedObligation[]): Address[] {
  const set = new Set<Address>();
  for (const o of obs) {
    set.add(o.debtor as Address);
    set.add(o.creditor as Address);
  }
  return [...set];
}

export interface SettlementBatch {
  epochId: bigint;
  grossVolume: bigint;
  netVolume: bigint;
  creditDrawn: bigint;
  obligationCount: bigint;
  memberCount: bigint;
  capitalFreedBps: bigint;
}

/**
 * Run one clearing epoch: preview the net off-chain (mirrors the contract), submit the
 * signed obligation set to settleEpoch, wait for the receipt, and decode SettlementBatch.
 */
export async function runEpoch(opts: {
  publicClient: PublicClient;
  settler: WalletClient; // any funded account submits the batch
  clearingHouse: Address;
  abi: Abi;
  epochId: bigint;
  obligations: SignedObligation[];
}) {
  const { publicClient, settler, clearingHouse, abi, epochId, obligations } = opts;
  const members = membersOf(obligations);
  const preview = netGraph(obligations);

  const hash = await settler.writeContract({
    address: clearingHouse,
    abi,
    functionName: "settleEpoch",
    args: [
      epochId,
      members,
      obligations.map((o) => ({
        debtor: o.debtor,
        creditor: o.creditor,
        amount: o.amount,
        nonce: o.nonce,
        epochId: o.epochId,
        signature: o.signature,
      })),
    ],
    account: settler.account!,
    chain: settler.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  let batch: SettlementBatch | null = null;
  for (const log of receipt.logs) {
    try {
      const parsed = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (parsed.eventName === "SettlementBatch") batch = parsed.args as unknown as SettlementBatch;
    } catch {
      /* not our event */
    }
  }

  return { hash, receipt, preview, batch, members };
}
