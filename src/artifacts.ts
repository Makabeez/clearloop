import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";

// Path to the kit's `forge build` output. Default assumes the two repos sit side by side.
const KIT_OUT = process.env.KIT_OUT ?? resolve(process.cwd(), "..", "clearloop-kit", "out");

function load(file: string, contract: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(KIT_OUT, file, `${contract}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Could not read artifact at ${path}. Run \`forge build\` in clearloop-kit, ` +
        `or set KIT_OUT to its out/ directory.`,
    );
  }
  const art = JSON.parse(raw);
  return { abi: art.abi as Abi, bytecode: art.bytecode.object as Hex };
}

export const clearingHouseArtifact = () => load("ClearingHouse.sol", "ClearingHouse");
export const creditRegistryArtifact = () => load("CreditRegistry.sol", "CreditRegistry");
export const mockUsdcArtifact = () => load("MockUSDC.sol", "MockUSDC");
