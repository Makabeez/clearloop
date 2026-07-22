import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";
import { signObligationLocal, type SignedObligation } from "./obligation.js";
import type { Obligation } from "./netting.js";

/**
 * A minimal autonomous participant: holds a key, and when it decides to pay a
 * counterparty it emits a debtor-signed obligation. In the full app this decision
 * comes from a buy/sell loop (buy compute, sell data, …); here `issue` is the seam.
 */
export class Agent {
  readonly account: LocalAccount;

  constructor(
    readonly pk: Hex,
    readonly name: string,
  ) {
    this.account = privateKeyToAccount(pk);
  }

  get address(): Address {
    return this.account.address;
  }

  async issue(
    creditor: Address,
    amount: bigint,
    nonce: bigint,
    epochId: bigint,
    chainId: number,
    clearingHouse: Address,
  ): Promise<SignedObligation> {
    const ob: Obligation = { debtor: this.address, creditor, amount, nonce, epochId };
    const signature = await signObligationLocal(this.account, chainId, clearingHouse, ob);
    return { ...ob, signature };
  }
}
