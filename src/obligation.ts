// EIP-712 obligation signing. Domain + types match ClearingHouse.sol byte-for-byte,
// so a signature produced here verifies inside settleEpoch on Arc.
//
// Contract typehash:
//   Obligation(address debtor,address creditor,uint256 amount,uint256 nonce,uint256 epochId)
// Contract domain: name "Clearloop", version "1", chainId, verifyingContract = ClearingHouse.

import type { Account, Address, Hex, LocalAccount, WalletClient } from "viem";
import type { Obligation } from "./netting.js";

export const OBLIGATION_TYPES = {
  Obligation: [
    { name: "debtor", type: "address" },
    { name: "creditor", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "epochId", type: "uint256" },
  ],
} as const;

export function clearloopDomain(chainId: number, verifyingContract: Address) {
  return {
    name: "Clearloop",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

/** Sign an obligation as the debtor. Returns a 65-byte signature usable in settleEpoch. */
export async function signObligation(
  wallet: WalletClient,
  account: Account,
  chainId: number,
  verifyingContract: Address,
  ob: Obligation,
): Promise<Hex> {
  return wallet.signTypedData({
    account,
    domain: clearloopDomain(chainId, verifyingContract),
    types: OBLIGATION_TYPES,
    primaryType: "Obligation",
    message: {
      debtor: ob.debtor as Address,
      creditor: ob.creditor as Address,
      amount: ob.amount,
      nonce: ob.nonce,
      epochId: ob.epochId,
    },
  });
}

/** Sign as the debtor using a local account directly (no transport needed). */
export async function signObligationLocal(
  account: LocalAccount,
  chainId: number,
  verifyingContract: Address,
  ob: Obligation,
): Promise<Hex> {
  return account.signTypedData({
    domain: clearloopDomain(chainId, verifyingContract),
    types: OBLIGATION_TYPES,
    primaryType: "Obligation",
    message: {
      debtor: ob.debtor as Address,
      creditor: ob.creditor as Address,
      amount: ob.amount,
      nonce: ob.nonce,
      epochId: ob.epochId,
    },
  });
}

/** The tuple shape settleEpoch expects for each obligation (with the signature appended). */
export interface SignedObligation extends Obligation {
  signature: Hex;
}
