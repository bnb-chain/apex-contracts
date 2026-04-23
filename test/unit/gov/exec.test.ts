import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseUnits } from "viem";
import { execDryRun, formatCalldata } from "../../../scripts/gov/lib/exec.js";
import type { CallItem } from "../../../scripts/gov/lib/types.js";

describe("formatCalldata", () => {
  it("renders each CallItem as a human-readable block", () => {
    const calls: CallItem[] = [
      {
        to: "0x1111111111111111111111111111111111111111",
        data: "0xabcdef",
        description: "pause()",
      },
    ];
    const out = formatCalldata(calls);
    assert.match(out, /pause\(\)/);
    assert.match(out, /0x1111111111111111111111111111111111111111/);
    assert.match(out, /0xabcdef/);
  });
});

describe("execDryRun", () => {
  it("returns success + gas estimate for a valid call", async () => {
    const { viem } = await network.connect();
    const [deployerW] = await viem.getWalletClients();
    const token = await viem.deployContract("ERC20MinimalMock", ["Test", "T", 18]);
    await token.write.mint([getAddress(deployerW.account.address), parseUnits("1", 18)]);
    const call: CallItem = {
      to: token.address,
      data: encodeFunctionData({
        abi: token.abi,
        functionName: "mint",
        args: [getAddress(deployerW.account.address), 1n],
      }),
      description: "mint(1)",
    };
    const [result] = await execDryRun(viem, getAddress(deployerW.account.address), [call]);
    assert.equal(result.ok, true);
    assert.ok(result.gas! > 0n);
  });

  it("reports revert reason when call would fail", async () => {
    const { viem } = await network.connect();
    const [deployerW] = await viem.getWalletClients();
    const token = await viem.deployContract("ERC20MinimalMock", ["Test", "T", 18]);
    // Not minted → transfer will revert.
    const call: CallItem = {
      to: token.address,
      data: encodeFunctionData({
        abi: token.abi,
        functionName: "transfer",
        args: ["0x0000000000000000000000000000000000000001", 1n],
      }),
      description: "transfer(1)",
    };
    const [result] = await execDryRun(viem, getAddress(deployerW.account.address), [call]);
    assert.equal(result.ok, false);
    assert.ok(result.error !== undefined);
  });
});
