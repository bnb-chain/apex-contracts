// ESM→CJS interop: @safe-global/{protocol-kit,api-kit} ship as CJS bundles.
// TypeScript node16 + "type":"module" treats `import X from "cjs-pkg"` as
// binding X to module.exports (the namespace object), so static `default`
// import fails to resolve `.init` / constructors. We use createRequire to
// load the CJS modules directly and cast to the declared types.
import { createRequire } from "node:module";
import type { SafeConfig } from "@safe-global/protocol-kit";
import type { SafeTransaction, SafeSignature } from "@safe-global/types-kit";
import type { SafeApiKitConfig, ProposeTransactionProps } from "@safe-global/api-kit";
import type { CallItem, GovContext } from "./types.js";

const _require = createRequire(import.meta.url);

// Minimal structural types derived from the SDK's declared interfaces.
// We avoid `typeof SafeClass` / `InstanceType<...>` because node16 + CJS
// interop resolves those to the module namespace type, not the class type.
type SafeInstance = {
  createTransaction(props: {
    transactions: { to: string; value: string; data: string }[];
  }): Promise<SafeTransaction>;
  getTransactionHash(tx: SafeTransaction): Promise<string>;
  signHash(hash: string): Promise<SafeSignature>;
};
type SafeStatic = { init(config: SafeConfig): Promise<SafeInstance> };
type ApiKitInstance = { proposeTransaction(props: ProposeTransactionProps): Promise<void> };
type ApiKitStatic = new (config: SafeApiKitConfig) => ApiKitInstance;

const Safe = (_require("@safe-global/protocol-kit") as { default: SafeStatic }).default;
const SafeApiKit = (_require("@safe-global/api-kit") as { default: ApiKitStatic }).default;

/**
 * Build a Safe MultiSend transaction data array from CallItems.
 * Protocol-kit accepts `{ to, value, data }`; description is dropped.
 */
function toSafeTxData(calls: CallItem[]) {
  return calls.map((c) => ({
    to: c.to,
    value: (c.value ?? 0n).toString(),
    data: c.data,
  }));
}

export async function proposeToSafe(ctx: GovContext, calls: CallItem[]): Promise<void> {
  const multisig = ctx.cfg.multisig;
  if (!multisig) throw new Error("cfg.multisig is required for --propose");

  const rpcUrl = process.env.BSC_TESTNET_RPC_URL ?? process.env.BSC_RPC_URL;
  if (!rpcUrl) throw new Error("BSC_TESTNET_RPC_URL or BSC_RPC_URL must be set");

  const privateKey = process.env.BSC_TESTNET_PRIVATE_KEY ?? process.env.BSC_PRIVATE_KEY;
  if (!privateKey)
    throw new Error("BSC_TESTNET_PRIVATE_KEY or BSC_PRIVATE_KEY must be set for --propose");

  const publicClient = await ctx.viem.getPublicClient();
  const chainId = BigInt(await publicClient.getChainId());

  const safe = await Safe.init({
    provider: rpcUrl,
    signer: privateKey,
    safeAddress: multisig,
  });

  const apiKit = new SafeApiKit({ chainId });

  const txs = toSafeTxData(calls);
  const safeTx = await safe.createTransaction({ transactions: txs });
  const safeTxHash = await safe.getTransactionHash(safeTx);
  const signature = await safe.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress: multisig,
    safeTransactionData: safeTx.data,
    safeTxHash,
    senderAddress: ctx.deployer,
    senderSignature: signature.data,
  });

  console.log(`[propose] Safe batch proposed (${calls.length} item${calls.length > 1 ? "s" : ""})`);
  console.log(`  safe    : ${multisig}`);
  console.log(`  txHash  : ${safeTxHash}`);
  const shortName = chainId === 56n ? "bnb" : chainId === 97n ? "bnbt" : null;
  if (shortName === null) {
    console.log(
      `  sign at : (no Safe UI short-name for chainId ${chainId}; open Safe UI manually)`,
    );
  } else {
    console.log(
      `  sign at : https://app.safe.global/transactions/queue?safe=${shortName}:${multisig}`,
    );
  }
}
