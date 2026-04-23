import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickMode } from "../../../scripts/gov/lib/config.js";

describe("pickMode", () => {
  it("dry-run flag wins regardless of multisig state", () => {
    assert.equal(pickMode({ "dry-run": true }, false), "dry-run");
    assert.equal(pickMode({ "dry-run": true }, true), "dry-run");
    assert.equal(pickMode({ "dry-run": true, propose: true }, true), "dry-run");
  });

  it("no multisig → eoa", () => {
    assert.equal(pickMode({}, false), "eoa");
    assert.equal(pickMode({ propose: true }, false), "eoa");
  });

  it("multisig + propose → propose", () => {
    assert.equal(pickMode({ propose: true }, true), "propose");
  });

  it("multisig without propose → calldata", () => {
    assert.equal(pickMode({}, true), "calldata");
  });
});
