import { network } from "hardhat";
import { isMainScript } from "../lib/is-main.js";
import type { AnyViem } from "../lib/types.js";

export type DeployTimelockOpts = {
  multisig: `0x${string}`;
  admin: `0x${string}`;
  minDelay: bigint;
};

/**
 * Deploys an OpenZeppelin TimelockController with:
 *   - minDelay = opts.minDelay (0 for testnet; raise via updateDelay later)
 *   - proposers = [multisig]
 *   - executors = [multisig]
 *   - admin     = opts.admin (usually deployer; should be renounced later)
 *
 * Returns the Timelock address. Intentionally EOA-only — no Safe path: at
 * deploy-time the Safe has no way to control anything on-chain yet.
 */
export async function deployTimelock(
  viem: AnyViem,
  opts: DeployTimelockOpts,
): Promise<`0x${string}`> {
  const tl = await viem.deployContract("TimelockController", [
    opts.minDelay,
    [opts.multisig],
    [opts.multisig],
    opts.admin,
  ]);
  return tl.address as `0x${string}`;
}

async function main(): Promise<void> {
  const { viem, networkName } = await network.connect();
  const { ADDRESSES } = await import("../../addresses.js");
  const cfg = ADDRESSES[networkName] ?? {};
  if (!cfg.multisig) throw new Error(`multisig missing in ADDRESSES[${networkName}]`);

  const [walletClient] = await viem.getWalletClients();
  const admin = walletClient.account.address as `0x${string}`;

  console.log(`\n=== Deploying TimelockController ===`);
  console.log(`Network : ${networkName}`);
  console.log(`Multisig: ${cfg.multisig}`);
  console.log(`Admin   : ${admin} (deployer; renounce once governance is set)`);
  console.log(`Delay   : 0 (testnet; call updateDelay later for mainnet)`);

  const address = await deployTimelock(viem, {
    multisig: cfg.multisig,
    admin,
    minDelay: 0n,
  });

  console.log(`\nTimelock deployed: ${address}`);
  console.log(`\nPaste into ADDRESSES["${networkName}"] in scripts/addresses.ts:`);
  console.log(`    timelockProxy: "${address}",`);
  console.log(`\nFollow-up (from deployer) when governance is fully wired:`);
  console.log(`    timelock.renounceRole(TIMELOCK_ADMIN_ROLE, deployer)`);
}

if (isMainScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
