/**
 * Structured logger for the E2E runner. Output stays line-oriented so CI
 * grep + copy-paste debugging remain trivial.
 */

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface Logger {
  header(title: string): void;
  step(flow: string, msg: string): void;
  info(msg: string): void;
  tx(hash: `0x${string}`, label?: string): void;
  ok(msg: string): void;
  fail(msg: string): void;
  warn(msg: string): void;
}

function explorerPrefix(networkName: string): string | undefined {
  if (networkName === "bscTestnet") return "https://testnet.bscscan.com/tx/";
  if (networkName === "bsc") return "https://bscscan.com/tx/";
  return undefined;
}

export function createLogger(networkName: string): Logger {
  const prefix = explorerPrefix(networkName);
  return {
    header(title) {
      console.log(`\n${CYAN}=== ${title} ===${RESET}`);
    },
    step(flow, msg) {
      console.log(`  ${DIM}[${flow}]${RESET} ${msg}`);
    },
    info(msg) {
      console.log(`  ${msg}`);
    },
    tx(hash, label) {
      const url = prefix ? `${prefix}${hash}` : hash;
      console.log(`    ${DIM}tx${label ? `(${label})` : ""}:${RESET} ${url}`);
    },
    ok(msg) {
      console.log(`  ${GREEN}✓${RESET} ${msg}`);
    },
    fail(msg) {
      console.log(`  ${RED}✗${RESET} ${msg}`);
    },
    warn(msg) {
      console.log(`  ${YELLOW}!${RESET} ${msg}`);
    },
  };
}

export function maskAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
