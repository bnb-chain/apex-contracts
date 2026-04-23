import { getAddress } from "viem";
import { ADDRESSES } from "../../addresses.js";
import type { AnyViem, ExecMode, GovContext } from "./types.js";
import { parseGovArgs, type ParsedArgs } from "./cli.js";

type NetworkConnection = {
  viem: AnyViem;
  networkName: string;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function pickMode(flags: Record<string, string | boolean>, hasMultisig: boolean): ExecMode {
  if (flags["dry-run"] === true) return "dry-run";
  if (!hasMultisig) return "eoa";
  if (flags["propose"] === true) return "propose";
  return "calldata";
}

export async function buildContext(
  conn: NetworkConnection,
  flags: Record<string, string | boolean>,
): Promise<GovContext> {
  const cfg = ADDRESSES[conn.networkName] ?? {};
  const [walletClient] = await conn.viem.getWalletClients();
  const deployer = getAddress(walletClient.account.address);
  const hasMultisig = !!cfg.multisig && cfg.multisig.toLowerCase() !== ZERO_ADDRESS;
  const mode = pickMode(flags, hasMultisig);
  return {
    cfg,
    networkName: conn.networkName,
    deployer,
    mode,
    viem: conn.viem,
  };
}

export async function parseAndBuild(
  argv: string[],
  conn: NetworkConnection,
  knownFlags: string[],
  booleanFlags: string[] = [],
): Promise<{ parsed: ParsedArgs; ctx: GovContext }> {
  const parsed = parseGovArgs(argv, { knownFlags, booleanFlags });
  const ctx = await buildContext(conn, parsed.flags);
  return { parsed, ctx };
}
