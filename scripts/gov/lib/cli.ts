import { getAddress } from "viem";

export type ParsedArgs = {
  op: string;
  flags: Record<string, string | boolean>;
};

const BUILTIN_BOOLEAN_FLAGS = new Set(["dry-run", "propose"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function parseGovArgs(
  argv: string[],
  opts: { knownFlags?: string[]; booleanFlags?: string[] } = {},
): ParsedArgs {
  const booleanFlags = new Set<string>([...BUILTIN_BOOLEAN_FLAGS, ...(opts.booleanFlags ?? [])]);
  const known = opts.knownFlags ? new Set([...opts.knownFlags, ...booleanFlags]) : null;
  const tokens = argv.slice(2);
  let op = "";
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (name.includes("=")) {
        throw new Error(`use --${name.split("=")[0]} <value>, not --${name}`);
      }
      if (known && !known.has(name)) throw new Error(`unknown flag: ${name}`);
      if (booleanFlags.has(name)) {
        flags[name] = true;
      } else {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`flag --${name} requires a value`);
        }
        flags[name] = value;
        i++;
      }
    } else if (op === "") {
      op = tok;
    } else {
      throw new Error(`unexpected positional argument: ${tok}`);
    }
  }

  return { op, flags };
}

export function requireString(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing --${name}`);
  return v;
}

export function requireAddress(
  flags: Record<string, string | boolean>,
  name: string,
): `0x${string}` {
  const raw = requireString(flags, name);
  let normalized: `0x${string}`;
  try {
    normalized = getAddress(raw);
  } catch {
    throw new Error(`--${name} is not a valid address: ${raw}`);
  }
  if (normalized.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`--${name} must not be the zero address`);
  }
  return normalized;
}
