import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGovArgs, requireString, requireAddress } from "../../../scripts/gov/lib/cli.js";

describe("parseGovArgs", () => {
  it("extracts operation name and string flags", () => {
    const argv = ["node", "script.ts", "setPlatformFee", "--fee-bp", "100", "--treasury", "0xabc"];
    const result = parseGovArgs(argv);
    assert.equal(result.op, "setPlatformFee");
    assert.equal(result.flags["fee-bp"], "100");
    assert.equal(result.flags["treasury"], "0xabc");
  });

  it("treats --dry-run and --propose as boolean flags", () => {
    const argv = ["node", "script.ts", "pause", "--dry-run"];
    const result = parseGovArgs(argv);
    assert.equal(result.op, "pause");
    assert.equal(result.flags["dry-run"], true);
  });

  it("defaults op to empty string when first positional is a flag", () => {
    const argv = ["node", "script.ts", "--dry-run"];
    const result = parseGovArgs(argv);
    assert.equal(result.op, "");
    assert.equal(result.flags["dry-run"], true);
  });

  it("throws on unknown flag names if a schema is provided", () => {
    assert.throws(
      () =>
        parseGovArgs(["node", "script.ts", "pause", "--bogus", "x"], {
          knownFlags: ["dry-run", "propose"],
        }),
      /unknown flag: bogus/,
    );
  });
});

describe("requireString", () => {
  it("returns string flag value", () => {
    assert.equal(requireString({ foo: "hello" }, "foo"), "hello");
  });

  it("throws when flag is missing", () => {
    assert.throws(() => requireString({}, "foo"), /missing --foo/);
  });

  it("throws when flag value is empty", () => {
    assert.throws(() => requireString({ foo: "" }, "foo"), /missing --foo/);
  });

  it("throws when flag value is boolean", () => {
    assert.throws(() => requireString({ foo: true }, "foo"), /missing --foo/);
  });
});

describe("requireAddress", () => {
  const valid = "0x1111111111111111111111111111111111111111";

  it("returns a checksummed address for a valid input", () => {
    const result = requireAddress({ to: valid }, "to");
    assert.equal(result.toLowerCase(), valid.toLowerCase());
    assert.match(result, /^0x[0-9a-fA-F]{40}$/);
  });

  it("normalizes lowercase input to EIP-55 checksum", () => {
    // A known EIP-55 address: vitalik.eth
    const lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const expected = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const result = requireAddress({ to: lower }, "to");
    assert.equal(result, expected);
  });

  it("throws on malformed address (wrong length)", () => {
    assert.throws(() => requireAddress({ to: "0xabc" }, "to"), /--to is not a valid address/);
  });

  it("throws on malformed address (non-hex chars)", () => {
    const bad = "0xzzzz111111111111111111111111111111111111";
    assert.throws(() => requireAddress({ to: bad }, "to"), /--to is not a valid address/);
  });

  it("throws when address is missing", () => {
    assert.throws(() => requireAddress({}, "to"), /missing --to/);
  });

  it("throws on the zero address", () => {
    assert.throws(
      () => requireAddress({ to: "0x0000000000000000000000000000000000000000" }, "to"),
      /must not be the zero address/,
    );
  });
});

describe("parseGovArgs --flag=value form", () => {
  it("rejects --flag=value with a clear error", () => {
    assert.throws(
      () => parseGovArgs(["node", "script.ts", "pause", "--fee-bp=100"]),
      /use --fee-bp <value>, not --fee-bp=100/,
    );
  });
});

describe("parseGovArgs booleanFlags option", () => {
  it("treats per-script booleanFlags as boolean", () => {
    const result = parseGovArgs(["node", "script.ts", "--commerce"], {
      booleanFlags: ["commerce"],
    });
    assert.equal(result.flags["commerce"], true);
  });

  it("built-in dry-run + propose still boolean when booleanFlags is provided", () => {
    const result = parseGovArgs(["node", "script.ts", "--dry-run"], {
      booleanFlags: ["commerce"],
    });
    assert.equal(result.flags["dry-run"], true);
  });
});
