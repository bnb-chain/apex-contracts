import { network } from "hardhat";
import { getAddress } from "viem";
import { getAddresses } from "./addresses.js";

/**
 * Upgrade the EvaluatorRouterUpgradeable implementation behind its proxy.
 *
 * !! IMPORTANT !!
 * The Router is also the `hook` of every registered job (ERC-8183 §5.2).
 * ERC-8183 recommends SHOULD NOT upgrade hooks after a job is created.
 * Only upgrade in emergencies. Prefer the drain-and-redeploy strategy:
 *   - router.pause()            (blocks new registrations)
 *   - wait for all in-flight jobs to settle OR let them expire + claimRefund
 *   - deploy a fresh Router behind a new proxy
 *
 * If you still want to upgrade in place, the flow below signs the upgrade
 * with the current owner. Strongly recommended: route this via a
 * TimelockController.
 *
 * Proxy address is read from scripts/addresses.ts.
 */

async function main() {
  const { viem, networkName } = await network.connect();
  const [signer] = await viem.getWalletClients();

  const proxyAddr = getAddresses(networkName).routerProxy;

  console.log(`\n=== upgrade EvaluatorRouter ===`);
  console.log(`Network: ${networkName}`);
  console.log(`Proxy  : ${proxyAddr}`);
  console.log(`Signer : ${getAddress(signer.account.address)}`);
  console.log(`\nWARNING: Router doubles as ERC-8183 hook. Prefer drain-and-redeploy.\n`);

  const newImpl = await viem.deployContract("EvaluatorRouterUpgradeable", []);
  console.log(`New impl: ${newImpl.address}`);

  const proxy = await viem.getContractAt("EvaluatorRouterUpgradeable", proxyAddr);
  const tx = await proxy.write.upgradeToAndCall([newImpl.address, "0x"]);
  console.log(`upgradeToAndCall tx: ${tx}`);
  console.log(`\nDone. Impl address is now ${newImpl.address} (for Etherscan verify).\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
