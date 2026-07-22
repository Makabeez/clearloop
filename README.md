# clearloop

**Multilateral clearing for the agent economy — settle the net, not the gross.** Autonomous agents are buyers *and* sellers at once, so their mutual obligations form a graph, not a line. Clearloop offsets every agent's receivables against its payables across that graph and settles only net USDC on Arc — freeing the working capital that per-payer batching leaves locked.

This is the app repo (netting engine, coordinator, agents, UI). Contracts live in [`clearloop-kit`](../clearloop-kit).

## Run

```bash
npm install
npm test        # 5 tests: cyclic graph nets to zero, bilateral offset, conservation, dense-graph savings
npm run demo    # generate a dense agent graph and print the capital-freed headline
```

Example `npm run demo` output — 15 agents, 200 obligations:

```
  gross volume .......... $9376
  net volume moved ...... $1047
  settlements ........... 14   (vs 200 gross payments)
  capital freed ......... 88.8%
```

Tune with `AGENTS=20 EDGES=300 SEED=7 npm run demo`.

## On-chain end-to-end

Runs the whole cycle against a real chain: deploy → fund agents → agents sign obligations → coordinator nets → `settleEpoch` on-chain → decoded result.

**Local (anvil):** in one terminal `anvil`; in another:

```bash
npm run e2e
```

Example output — 5 signed obligations settled in one tx:

```
  gross volume ...... $155
  net moved ......... $25
  obligations ....... 5   →   settlements 2
  capital freed ..... 83.9%
  tx ................ 0x67f5...c6c7
  cleared balances:  Alice $75   Bob $110   Carol $115
```

**Arc testnet:** copy `.env.example` to `.env`, fill in RPC/USDC/ClearingHouse/keys, then `npm run e2e` — same command, no code change. Deploy the contract first from the kit: `forge script script/Deploy.s.sol --rpc-url $ARC_RPC --private-key $DEPLOYER_KEY --broadcast`.

**Coordinator service** (agents POST obligations over the network):

```bash
CLEARINGHOUSE_ADDRESS=0x... DEPLOYER_KEY=0x... npm run coordinator
# POST /obligations  {debtor,creditor,amount,nonce,epochId,signature}
# POST /settle       {epochId}   -> nets the pool, submits one epoch, returns tx + batch
```

## x402 — agents paying agents

Clearloop speaks x402 (the same HTTP-402 negotiation standard Circle Nanopayments uses). Circle ships the `GatewayWalletBatched` scheme, which batches on the *buyer* side; Clearloop registers a sibling scheme, `clearloop-exact`, using the same EIP-712 / EIP-3009-shaped authorization — but the payloads clear **multilaterally** across the agent graph. Same rail family, one layer up.

Each agent runs a paywalled service and buys from the others. Every purchase is a signed obligation that drops into the netting graph:

```bash
npm run x402
```

```
  Alice → Bob    $1.5  price-feed
  Bob   → Carol  $3    compute
  Carol → Alice  $2    risk-score
  ...
  gross $16 → net $5.50 · 65.6% freed · 2 settlements
```

The same signed obligations settle on Arc via `npm run e2e`. Productionization: sign the payload as an EIP-3009 `TransferWithAuthorization` so one signature is redeemable by either Circle Gateway (buyer-side) or Clearloop (multilateral) — see `src/x402.ts`.

## Credit facility

A net-debtor can clear beyond its collateral against a reputation-priced credit line (`CreditRegistry`). The shortfall is fronted from the house reserve and recorded as debt; creditors are always paid in full. Default waterfall: `repay()` clears debt, `liquidate()` seizes a delinquent member's collateral back into the reserve.

```bash
anvil            # one terminal
npm run credit   # another
```

```
  credit drawn ...... $40   ← Dave cleared past his $10 collateral
  Dave debt ......... $40   (owed to the house)
  Alice paid full ... $130  (creditor unaffected)
  → Dave repays. debt $0 · reserve back to $100
```

## Visual hero

`web/index.html` — open in a browser (no build). Hit **Run clearing epoch**: the gross obligation mesh collapses into net settlement arcs, agents recolor by net position, and the ledger counts up to the capital-freed figure. Toggle **Dense · 15 agents** for the 88.8% view.

## What's here

| File | Role |
|---|---|
| `src/netting.ts` | Multilateral netting engine (the IP). Mirrors `ClearingHouse.settleEpoch`. |
| `src/obligation.ts` | EIP-712 signing (viem). Domain + types match `ClearingHouse.sol`. |
| `src/x402.ts` | The `clearloop-exact` x402 scheme — 402 terms, payload, verification. |
| `src/x402-agent.ts` | Paywalled seller agent + buyer `pay()` (the 402 round-trip). |
| `src/agent.ts` | An autonomous participant that issues signed obligations. |
| `src/coordinator.ts` | Pools obligations, submits `settleEpoch`, decodes `SettlementBatch`. |
| `src/coordinator-server.ts` | Thin HTTP coordinator (`/obligations`, `/settle`). |
| `src/chain.ts` / `src/artifacts.ts` | viem clients (env-driven, RPC backoff) + kit ABI loader. |
| `src/e2e.ts` | Full on-chain cycle — deploy / fund / settle. |
| `src/x402-demo.ts` | Agents buying from each other over x402, cleared multilaterally. |
| `src/credit-demo.ts` | Intraday credit: a thin-collateral agent clears on a credit line, then repays. |
| `src/demo.ts` | Offline console demo — the capital-freed number, no RPC. |
| `web/index.html` | Visual hero — the obligation graph collapsing gross→net. |

## Next

- [ ] Wire **`CreditRegistry`** into settlement (intraday credit for net-debtors).
- [ ] Sign obligations as EIP-3009 `TransferWithAuthorization` for one-signature Gateway/Clearloop interop.
- [ ] Autonomous agent **decision loop** tied to real price/budget signals.
