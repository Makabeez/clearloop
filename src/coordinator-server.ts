// Minimal HTTP coordinator. Agents POST signed obligations; POST /settle nets the
// pool and submits one epoch to ClearingHouse. Requires CLEARINGHOUSE_ADDRESS and
// DEPLOYER_KEY (the settler) in env. Deploy the contract first (forge script) or reuse
// the address printed by `npm run e2e`.
//
//   PORT=8787 CLEARINGHOUSE_ADDRESS=0x... DEPLOYER_KEY=0x... npm run coordinator

import { createServer } from "node:http";
import type { Address, Hex } from "viem";
import { publicClient, wallet } from "./chain.js";
import { clearingHouseArtifact } from "./artifacts.js";
import { runEpoch } from "./coordinator.js";
import type { SignedObligation } from "./obligation.js";

const PORT = Number(process.env.PORT ?? 8787);
const pool: SignedObligation[] = [];

function toObligation(b: any): SignedObligation {
  return {
    debtor: b.debtor,
    creditor: b.creditor,
    amount: BigInt(b.amount),
    nonce: BigInt(b.nonce ?? 0),
    epochId: BigInt(b.epochId),
    signature: b.signature as Hex,
  };
}

const jsonSafe = (o: unknown) =>
  JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function body(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        res(d ? JSON.parse(d) : {});
      } catch (e) {
        rej(e);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    if (req.method === "GET" && req.url === "/health") {
      return res.end(jsonSafe({ ok: true, pool: pool.length }));
    }
    if (req.method === "GET" && req.url === "/pool") {
      return res.end(jsonSafe({ pool }));
    }
    if (req.method === "POST" && req.url === "/obligations") {
      const ob = toObligation(await body(req));
      pool.push(ob);
      return res.end(jsonSafe({ ok: true, pool: pool.length }));
    }
    if (req.method === "POST" && req.url === "/settle") {
      const { epochId } = await body(req);
      const chAddr = process.env.CLEARINGHOUSE_ADDRESS as Address;
      const settler = wallet(process.env.DEPLOYER_KEY as Hex);
      const eid = BigInt(epochId);
      const obligations = pool.filter((o) => o.epochId === eid);
      const { hash, batch, preview } = await runEpoch({
        publicClient, settler, clearingHouse: chAddr,
        abi: clearingHouseArtifact().abi, epochId: eid, obligations,
      });
      // clear settled epoch from the pool
      for (let i = pool.length - 1; i >= 0; i--) if (pool[i].epochId === eid) pool.splice(i, 1);
      return res.end(jsonSafe({ hash, batch, settlements: preview.settlements }));
    }
    res.statusCode = 404;
    res.end(jsonSafe({ error: "not found" }));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(jsonSafe({ error: e?.message ?? String(e) }));
  }
});

server.listen(PORT, () => console.log(`coordinator listening on :${PORT}`));
