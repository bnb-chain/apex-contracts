/**
 * E2E runner configuration.
 *
 * All parameters have sensible defaults for local runs so `bun run e2e:local`
 * needs zero configuration. Testnet reuses `BSC_TESTNET_PRIVATE_KEY` (the
 * same key hardhat already requires for the `bscTestnet` network) as the
 * owner + client + provider by default. See `test/e2e/README.md`.
 */

const SUPPORTED_NETWORKS = new Set(["localhost", "bscTestnet"]);

export type NetworkKind = "local" | "testnet";

export interface E2EConfig {
  networkName: string;
  kind: NetworkKind;
  disputeWindowSeconds: number;
  jobExpirySeconds: number;
  budgetUnits: number;
  initialQuorum: number;
  failFast: boolean;
  slackSeconds: number;
  testnet?: {
    ownerKey: `0x${string}`;
    clientKey: `0x${string}`;
    providerKey: `0x${string}`;
  };
}

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v.length === 0) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid integer env var ${key}=${v}`);
  }
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v.length === 0) return fallback;
  return v === "true" || v === "1";
}

function envPrivateKey(key: string): `0x${string}` {
  const v = env(key);
  const trimmed = v.trim();
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(`Invalid private key in ${key}: must be 32 bytes hex`);
  }
  return withPrefix as `0x${string}`;
}

export function loadConfig(networkName: string): E2EConfig {
  if (!SUPPORTED_NETWORKS.has(networkName)) {
    throw new Error(
      `E2E only supports ${[...SUPPORTED_NETWORKS].join(" / ")}; got "${networkName}".`,
    );
  }
  const kind: NetworkKind = networkName === "localhost" ? "local" : "testnet";

  const disputeWindowSeconds = envInt("E2E_DISPUTE_WINDOW_SECONDS", 15);
  // Kernel requires `expiredAt > now + 5 min`, so any value <= 300 will revert
  // inside createJob. 360 keeps a 1-minute buffer and is well over the
  // dispute-window default so the C / E flows can observe stalemate → expiry.
  const jobExpirySeconds = envInt("E2E_JOB_EXPIRY_SECONDS", 360);
  const slackSeconds = envInt("E2E_SLACK_SECONDS", 3);
  const budgetUnits = envInt("E2E_BUDGET_UNITS", 1);
  const initialQuorum = envInt("E2E_INITIAL_QUORUM", kind === "local" ? 2 : 1);
  const failFast = envBool("E2E_FAIL_FAST", true);

  // Kernel constraint: `expiredAt > now + 5 min`.
  if (jobExpirySeconds <= 300) {
    throw new Error(
      `E2E_JOB_EXPIRY_SECONDS (${jobExpirySeconds}) must be > 300 (kernel requires ` +
        `expiredAt > now + 5 min).`,
    );
  }
  // Stalemate-expire flow wants dispute window to fully fit inside job expiry.
  const minExpiry = disputeWindowSeconds + slackSeconds + 1;
  if (jobExpirySeconds < minExpiry) {
    throw new Error(
      `E2E_JOB_EXPIRY_SECONDS (${jobExpirySeconds}) must be >= window + slack + 1 ` +
        `(${disputeWindowSeconds} + ${slackSeconds} + 1 = ${minExpiry}).`,
    );
  }

  const cfg: E2EConfig = {
    networkName,
    kind,
    disputeWindowSeconds,
    jobExpirySeconds,
    budgetUnits,
    initialQuorum,
    failFast,
    slackSeconds,
  };

  if (kind === "testnet") {
    // Reuse `BSC_TESTNET_PRIVATE_KEY` (already required by hardhat for the
    // `bscTestnet` network) as the owner. Deployer is router.owner() until
    // ownership is transferred, so this is the right key in the common case;
    // if ownership was transferred away, the preflight `Router owner mismatch`
    // error will make that obvious.
    // `E2E_CLIENT_KEY` / `E2E_PROVIDER_KEY` stay optional and fall back to the
    // owner, collapsing testnet E2E to a single wallet by default.
    const ownerKey = envPrivateKey("BSC_TESTNET_PRIVATE_KEY");
    cfg.testnet = {
      ownerKey,
      clientKey: envPrivateKeyOptional("E2E_CLIENT_KEY") ?? ownerKey,
      providerKey: envPrivateKeyOptional("E2E_PROVIDER_KEY") ?? ownerKey,
    };
  }

  return cfg;
}

function envPrivateKeyOptional(key: string): `0x${string}` | undefined {
  const v = process.env[key];
  if (v === undefined || v.trim().length === 0) return undefined;
  return envPrivateKey(key);
}
