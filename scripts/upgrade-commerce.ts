import { network } from "hardhat";
import { getAddress } from "viem";
import { getAddresses } from "./addresses.js";

/**
 * Upgrade the AgenticCommerceUpgradeable implementation behind its proxy.
 *
 * Proxy address is read from scripts/addresses.ts (hand-committed registry).
 * Signer MUST be the current owner.
 */

async function main() {
  const { viem, networkName } = await network.connect();
  const [signer] = await viem.getWalletClients();

  const proxyAddr = getAddresses(networkName).commerceProxy;

  console.log(`\n=== upgrade AgenticCommerce ===`);
  console.log(`Network: ${networkName}`);
  console.log(`Proxy  : ${proxyAddr}`);
  console.log(`Signer : ${getAddress(signer.account.address)}`);

  const newImpl = await viem.deployContract("AgenticCommerceUpgradeable", []);
  console.log(`New impl: ${newImpl.address}`);

  const proxy = await viem.getContractAt("AgenticCommerceUpgradeable", proxyAddr);
  const tx = await proxy.write.upgradeToAndCall([newImpl.address, "0x"]);
  console.log(`upgradeToAndCall tx: ${tx}`);
  console.log(`\nDone. Impl address is now ${newImpl.address} (for Etherscan verify).\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
