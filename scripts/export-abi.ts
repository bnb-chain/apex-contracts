import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Re-export slim ABI JSON files for the three public-facing contracts from
 * Hardhat artifacts into `abis/` at the repo root. Each output file is the
 * `abi` field of the artifact, stringified with 2-space indentation and a
 * trailing newline, so the folder round-trips cleanly under Prettier.
 *
 * Usage (wired into package.json as `bun run abis`):
 *
 *   bun run compile && bun scripts/export-abi.ts
 *
 * The contract list is an explicit allow-list to avoid leaking mock /
 * interface ABIs into the published folder. Extend it (sparingly) when a
 * new public-facing contract is added to `contracts/`.
 */

const CONTRACTS = [
  "AgenticCommerceUpgradeable",
  "EvaluatorRouterUpgradeable",
  "OptimisticPolicy",
] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS_DIR = join(ROOT, "artifacts", "contracts");
const OUT_DIR = join(ROOT, "abis");

function exportOne(name: string): void {
  const artifactPath = join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(artifactPath, "utf8");
  } catch {
    throw new Error(`Artifact not found at ${artifactPath}. Run \`bun run compile\` first.`);
  }
  const artifact = JSON.parse(raw) as { abi?: unknown[] };
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw new Error(`Artifact ${name} has no abi entries; refusing to write.`);
  }
  const outPath = join(OUT_DIR, `${name}.json`);
  writeFileSync(outPath, `${JSON.stringify(artifact.abi, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath} (${artifact.abi.length} entries)`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const name of CONTRACTS) exportOne(name);
