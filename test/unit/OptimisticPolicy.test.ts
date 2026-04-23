import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, parseEventLogs, toBytes, zeroAddress } from "viem";

import {
  Verdict,
  DEFAULT_BUDGET,
  DEFAULT_DISPUTE_WINDOW,
  deployStack,
  advanceSeconds,
  createFundedSubmittedJob,
} from "./helpers.js";

describe("OptimisticPolicy", async () => {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployerW, clientW, providerW, treasuryW, voter1W, voter2W, voter3W] =
    await viem.getWalletClients();
  const deployer = getAddress(deployerW.account.address);
  const treasury = getAddress(treasuryW.account.address);
  const voter1 = getAddress(voter1W.account.address);
  const voter2 = getAddress(voter2W.account.address);
  const voter3 = getAddress(voter3W.account.address);

  async function setup(initialQuorum = 2) {
    return deployStack(viem, {
      owner: deployer,
      treasury,
      initialQuorum,
      voters: [voter1, voter2],
    });
  }

  async function asPolicy(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("OptimisticPolicy", addr, { client: { wallet } });
  }

  // ==================================================================
  // Admin: voters
  // ==================================================================

  describe("admin: voters", () => {
    it("addVoter increments activeVoterCount", async () => {
      const { policy } = await setup();
      assert.equal(await policy.read.activeVoterCount(), 2);
      await policy.write.addVoter([voter3]);
      assert.equal(await policy.read.activeVoterCount(), 3);
      assert.equal(await policy.read.isVoter([voter3]), true);
    });

    it("removeVoter blocked if it would break quorum", async () => {
      const { policy } = await setup();
      // With quorum=2 and 2 voters, removing one would break.
      await assert.rejects(policy.write.removeVoter([voter1]), /WouldBreakQuorum/);
    });

    it("removeVoter works when headroom exists", async () => {
      const { policy } = await setup();
      await policy.write.addVoter([voter3]); // 3 voters, quorum 2
      await policy.write.removeVoter([voter1]);
      assert.equal(await policy.read.activeVoterCount(), 2);
      assert.equal(await policy.read.isVoter([voter1]), false);
    });

    it("setQuorum enforces <= activeVoterCount", async () => {
      const { policy } = await setup();
      await assert.rejects(policy.write.setQuorum([3]), /QuorumOutOfRange/);
      await policy.write.addVoter([voter3]);
      await policy.write.setQuorum([3]);
      assert.equal(await policy.read.voteQuorum(), 3);
    });

    it("setQuorum rejects zero", async () => {
      const { policy } = await setup();
      await assert.rejects(policy.write.setQuorum([0]), /QuorumZero/);
    });

    it("addVoter rejects duplicate address", async () => {
      const { policy } = await setup();
      await assert.rejects(policy.write.addVoter([voter1]), /VoterAlreadyExists/);
    });
  });

  // ==================================================================
  // Admin: two-step transfer
  // ==================================================================

  describe("admin: transfer", () => {
    it("two-step transfer flow", async () => {
      const { policy } = await setup();
      await policy.write.transferAdmin([voter1]);
      assert.equal(getAddress(await policy.read.pendingAdmin()), voter1);
      const asPending = await asPolicy(policy.address, voter1W);
      await asPending.write.acceptAdmin();
      assert.equal(getAddress(await policy.read.admin()), voter1);
      assert.equal(getAddress(await policy.read.pendingAdmin()), zeroAddress);
    });

    it("only pending can accept", async () => {
      const { policy } = await setup();
      await policy.write.transferAdmin([voter1]);
      const asWrong = await asPolicy(policy.address, voter2W);
      await assert.rejects(asWrong.write.acceptAdmin(), /NotPendingAdmin/);
    });
  });

  // ==================================================================
  // onSubmitted
  // ==================================================================

  describe("onSubmitted", () => {
    it("only router can call", async () => {
      const { policy } = await setup();
      await assert.rejects(
        policy.write.onSubmitted([1n, keccak256(toBytes("x")), "0x"]),
        /NotRouter/,
      );
    });

    it("records submittedAt on first-and-only call (via real submit)", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      assert.notEqual(await ctx.policy.read.submittedAt([jobId]), 0n);
    });
  });

  // ==================================================================
  // check: default-approve path
  // ==================================================================

  describe("check: default approve", () => {
    it("returns PENDING before submittedAt", async () => {
      const { policy } = await setup();
      const [verdict] = await policy.read.check([999n, "0x"]);
      assert.equal(verdict, Verdict.Pending);
    });

    it("returns PENDING within disputeWindow, APPROVE after", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      let [verdict] = await ctx.policy.read.check([jobId, "0x"]);
      assert.equal(verdict, Verdict.Pending);

      await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);
      [verdict] = await ctx.policy.read.check([jobId, "0x"]);
      assert.equal(verdict, Verdict.Approve);
    });
  });

  // ==================================================================
  // dispute + voteReject path
  // ==================================================================

  describe("dispute + voteReject", () => {
    it("client raises dispute, voters reach quorum → REJECT", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });

      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await policyAsClient.write.dispute([jobId]);

      let [verdict] = await ctx.policy.read.check([jobId, "0x"]);
      assert.equal(verdict, Verdict.Pending, "1 vote < quorum");

      const policyAsV1 = await asPolicy(ctx.policy.address, voter1W);
      await policyAsV1.write.voteReject([jobId]);

      [verdict] = await ctx.policy.read.check([jobId, "0x"]);
      assert.equal(verdict, Verdict.Pending, "still < quorum");

      const policyAsV2 = await asPolicy(ctx.policy.address, voter2W);
      await policyAsV2.write.voteReject([jobId]);

      [verdict] = await ctx.policy.read.check([jobId, "0x"]);
      assert.equal(verdict, Verdict.Reject);
    });

    it("dispute outside window reverts", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);
      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await assert.rejects(policyAsClient.write.dispute([jobId]), /OutsideDisputeWindow/);
    });

    it("dispute before submit reverts NotSubmitted", async () => {
      const ctx = await setup();
      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await assert.rejects(policyAsClient.write.dispute([42n]), /NotClient|NotSubmitted/);
    });

    it("non-client cannot dispute", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      const policyAsOther = await asPolicy(ctx.policy.address, voter1W);
      await assert.rejects(policyAsOther.write.dispute([jobId]), /NotClient/);
    });

    it("voter cannot vote twice", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await policyAsClient.write.dispute([jobId]);
      const policyAsV1 = await asPolicy(ctx.policy.address, voter1W);
      await policyAsV1.write.voteReject([jobId]);
      await assert.rejects(policyAsV1.write.voteReject([jobId]), /AlreadyVoted/);
    });

    it("non-voter cannot voteReject", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await policyAsClient.write.dispute([jobId]);
      const policyAsStranger = await asPolicy(ctx.policy.address, voter3W);
      await assert.rejects(policyAsStranger.write.voteReject([jobId]), /NotVoter/);
    });

    it("voteReject on a not-yet-disputed job reverts NotDisputed", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      const policyAsV1 = await asPolicy(ctx.policy.address, voter1W);
      await assert.rejects(policyAsV1.write.voteReject([jobId]), /NotDisputed/);
    });

    it("dispute cannot be raised twice (AlreadyDisputed)", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await policyAsClient.write.dispute([jobId]);
      await assert.rejects(policyAsClient.write.dispute([jobId]), /AlreadyDisputed/);
    });

    it("dispute on a Completed job reverts WrongJobStatus", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      // Fast-forward past the window and settle → kernel status becomes Completed.
      await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);
      await ctx.router.write.settle([jobId, "0x"]);

      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await assert.rejects(policyAsClient.write.dispute([jobId]), /WrongJobStatus/);
    });

    it("QuorumReached emitted on the vote that reaches quorum", async () => {
      const ctx = await setup(); // quorum = 2, voters = [voter1, voter2]
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });

      const policyAsClient = await asPolicy(ctx.policy.address, clientW);
      await policyAsClient.write.dispute([jobId]);

      // First vote (1 < quorum): no QuorumReached
      const policyAsV1 = await asPolicy(ctx.policy.address, voter1W);
      const tx1 = await policyAsV1.write.voteReject([jobId]);
      const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
      const qr1 = parseEventLogs({
        abi: ctx.policy.abi,
        logs: receipt1.logs,
        eventName: "QuorumReached",
      });
      assert.equal(qr1.length, 0, "QuorumReached should not fire below quorum");

      // Second vote (2 == quorum): QuorumReached fired
      const policyAsV2 = await asPolicy(ctx.policy.address, voter2W);
      const tx2 = await policyAsV2.write.voteReject([jobId]);
      const receipt2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
      const qr2 = parseEventLogs({
        abi: ctx.policy.abi,
        logs: receipt2.logs,
        eventName: "QuorumReached",
      }) as unknown as Array<{
        args: { jobId: bigint; rejectVotes: number };
      }>;
      assert.equal(qr2.length, 1);
      assert.equal(qr2[0].args.jobId, jobId);
      assert.equal(qr2[0].args.rejectVotes, 2);
    });
  });
});
