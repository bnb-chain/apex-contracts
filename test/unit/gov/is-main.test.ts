import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMainScript } from "../../../scripts/gov/lib/is-main.js";

describe("isMainScript", () => {
  const originalArgv = process.argv;

  it("matches when argv contains the script's relative path", () => {
    process.argv = ["node", "scripts/gov/commerce.ts"];
    assert.equal(isMainScript("file:///root/scripts/gov/commerce.ts"), true);
    process.argv = originalArgv;
  });

  it("matches when invoked via hardhat run", () => {
    process.argv = [
      "/path/to/node",
      "/path/to/hardhat",
      "run",
      "scripts/gov/commerce.ts",
      "--network",
      "bscTestnet",
    ];
    assert.equal(isMainScript("file:///root/scripts/gov/commerce.ts"), true);
    process.argv = originalArgv;
  });

  it("ignores flag tokens starting with -", () => {
    process.argv = ["node", "--network", "x"];
    assert.equal(isMainScript("file:///root/scripts/gov/commerce.ts"), false);
    process.argv = originalArgv;
  });

  it("returns false when no argv token matches the script URL", () => {
    process.argv = ["node", "scripts/gov/router.ts"];
    assert.equal(isMainScript("file:///root/scripts/gov/commerce.ts"), false);
    process.argv = originalArgv;
  });
});
