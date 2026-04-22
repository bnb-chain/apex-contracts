import { network } from "hardhat";
import { formatEther, formatUnits, getAddress, parseEther, parseUnits } from "viem";

/**
 * Top up a target address on a local / forked network with native coin and
 * MockERC20. Intended for end-to-end testing where a developer wants to act
 * as a client or provider agent using an address other than Hardhat's default
 * signer.
 *
 *   FUND_RECIPIENT=0x... FUND_TOKEN_ADDRESS=0x... bun run fund:local
 *
 * Env vars are intentionally passed inline (never committed to .env) because
 * the recipient and MockERC20 address change every fresh local node. The
 * deploy:local script prints the full ready-to-run command for you.
 *
 * Fixed defaults (edit this file to change):
 *   - 10 native coin
 *   - 10000 MockERC20 (18 decimals)
 *
 * Refuses to run on `bsc` or `bscTestnet` as a safety rail — minting real
 * tokens on a real network is never what you want.
 */

const LIVE_NETWORKS = new Set(["bsc", "bscTestnet"]);

const ETH_AMOUNT = parseEther("10");
const TOKEN_AMOUNT = parseUnits("10000", 18);

function required(key: string): `0x${string}` {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(
      `Missing env var: ${key}. Usage:\n` +
        `  FUND_RECIPIENT=0x... FUND_TOKEN_ADDRESS=0x... bun run fund:local`,
    );
  }
  return getAddress(v);
}

async function main() {
  const { viem, networkName } = await network.connect();

  if (LIVE_NETWORKS.has(networkName)) {
    throw new Error(
      `fund-local.ts refuses to run on live network "${networkName}". ` +
        `This script mints MockERC20 tokens and is meant for local / forked use only.`,
    );
  }

  const recipient = required("FUND_RECIPIENT");
  const tokenAddr = required("FUND_TOKEN_ADDRESS");

  const publicClient = await viem.getPublicClient();
  const [funder] = await viem.getWalletClients();
  const funderAddr = getAddress(funder.account.address);

  console.log(`\n=== fund-local ===`);
  console.log(`Network  : ${networkName}`);
  console.log(`Funder   : ${funderAddr}`);
  console.log(`Recipient: ${recipient}`);
  console.log(`Token    : ${tokenAddr}`);
  console.log(`ETH      : ${formatEther(ETH_AMOUNT)}`);
  console.log(`Token amt: ${formatUnits(TOKEN_AMOUNT, 18)}\n`);

  const ethTx = await funder.sendTransaction({ to: recipient, value: ETH_AMOUNT });
  await publicClient.waitForTransactionReceipt({ hash: ethTx });
  console.log(`ETH tx  : ${ethTx}`);

  // MockERC20.mint is permissionless (see contracts/MockERC20.sol).
  const token = await viem.getContractAt("MockERC20", tokenAddr);
  const mintTx = await token.write.mint([recipient, TOKEN_AMOUNT]);
  await publicClient.waitForTransactionReceipt({ hash: mintTx });
  console.log(`Mint tx : ${mintTx}`);

  const ethBal = await publicClient.getBalance({ address: recipient });
  const tokenBal = await token.read.balanceOf([recipient]);
  console.log(`\nRecipient balances:`);
  console.log(`  ETH  : ${formatEther(ethBal)}`);
  console.log(`  Token: ${formatUnits(tokenBal, 18)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
