import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, zeroAddress } from "viem";
import {
  JobStatus,
  DEFAULT_BUDGET,
  DISPUTE_WINDOW_SECONDS,
  VOTE_QUORUM,
  Verdict,
} from "./constants.js";
import { deployMockToken, deployAPEXProxy } from "./deploy.js";

describe("OptimisticPolicy", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const [deployer, client, provider, adminEoa, treasury, v1, v2, v3, v4, v5, stranger] =
    await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const adminAddress = getAddress(adminEoa.account.address);
  const treasuryAddress = getAddress(treasury.account.address);
  const voterAddrs = [v1, v2, v3, v4, v5].map((w) => getAddress(w.account.address));

  async function deployACPAndRouter() {
    const token = await deployMockToken(viem);
    const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);
    const router = await viem.deployContract("EvaluatorRouter", [apex.address, adminAddress]);
    return { token, apex, router };
  }

  async function deployPolicy(
    apexAddr: `0x${string}`,
    routerAddr: `0x${string}`,
    voters: `0x${string}`[] = voterAddrs,
    quorum: number = VOTE_QUORUM,
    window: bigint = DISPUTE_WINDOW_SECONDS,
    admin: `0x${string}` = adminAddress,
  ) {
    return viem.deployContract("OptimisticPolicy", [
      apexAddr,
      routerAddr,
      window,
      quorum,
      admin,
      voters,
    ]);
  }

  describe("Deployment", () => {
    it("records immutables and voter set", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      assert.equal(getAddress(await policy.read.acp()), getAddress(apex.address));
      assert.equal(getAddress(await policy.read.router()), getAddress(router.address));
      assert.equal(await policy.read.disputeWindow(), DISPUTE_WINDOW_SECONDS);
      assert.equal(await policy.read.voteQuorum(), VOTE_QUORUM);
      assert.equal(getAddress(await policy.read.admin()), adminAddress);
      assert.equal(await policy.read.activeVoterCount(), voterAddrs.length);
      for (const v of voterAddrs) {
        assert.equal(await policy.read.isVoter([v]), true);
      }
    });

    it("reverts if voters < quorum", async () => {
      const { apex, router } = await deployACPAndRouter();
      await assert.rejects(deployPolicy(apex.address, router.address, voterAddrs.slice(0, 2), 3));
    });

    it("reverts if quorum == 0", async () => {
      const { apex, router } = await deployACPAndRouter();
      await assert.rejects(deployPolicy(apex.address, router.address, voterAddrs, 0));
    });

    it("reverts on duplicate voter", async () => {
      const { apex, router } = await deployACPAndRouter();
      const dup = [...voterAddrs.slice(0, 3), voterAddrs[0]];
      await assert.rejects(deployPolicy(apex.address, router.address, dup, 3));
    });

    it("reverts on zero addresses (acp / router / admin / voter)", async () => {
      const { apex, router } = await deployACPAndRouter();
      await assert.rejects(deployPolicy(zeroAddress, router.address));
      await assert.rejects(deployPolicy(apex.address, zeroAddress));
      await assert.rejects(
        deployPolicy(
          apex.address,
          router.address,
          voterAddrs,
          VOTE_QUORUM,
          DISPUTE_WINDOW_SECONDS,
          zeroAddress,
        ),
      );
      const withZeroVoter = [...voterAddrs.slice(0, 4), zeroAddress as `0x${string}`];
      await assert.rejects(deployPolicy(apex.address, router.address, withZeroVoter));
    });
  });

  describe("dispute", () => {
    async function fixtureSubmittedJob() {
      const f = await deployACPAndRouter();
      const policy = await deployPolicy(f.apex.address, f.router.address);
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([policy.address, true]);

      // createJob → register → fund → submit
      const pc = await viem.getPublicClient();
      const block = await pc.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", f.apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        f.router.address,
        expiredAt,
        "job",
        zeroAddress,
      ]);
      const jobId = await f.apex.read.jobCounter();
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, policy.address]);
      await apexAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]);
      await f.token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", f.token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([f.apex.address, DEFAULT_BUDGET]);
      await apexAsClient.write.fund([jobId, DEFAULT_BUDGET, "0x"]);
      const apexAsProvider = await viem.getContractAt(
        "AgenticCommerceUpgradeable",
        f.apex.address,
        { client: { wallet: provider } },
      );
      await apexAsProvider.write.submit([jobId, keccak256("0xdead"), "0x"]);

      return { ...f, policy, jobId };
    }

    it("client can dispute while within window", async () => {
      const { policy, jobId } = await fixtureSubmittedJob();
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await policyAsClient.write.dispute([jobId]);
      assert.equal(await policy.read.disputed([jobId]), true);
    });

    it("reverts if not client", async () => {
      const { policy, jobId } = await fixtureSubmittedJob();
      const policyAsStranger = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: stranger },
      });
      await assert.rejects(policyAsStranger.write.dispute([jobId]));
    });

    it("reverts if status != Submitted", async () => {
      const { apex, router, policy } = await fixtureSubmittedJob();
      // Create a new Open job (not submitted)
      const pc = await viem.getPublicClient();
      const block = await pc.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        router.address,
        expiredAt,
        "job2",
        zeroAddress,
      ]);
      const jobId2 = await apex.read.jobCounter();

      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await assert.rejects(policyAsClient.write.dispute([jobId2]));
    });

    it("reverts after dispute window closes", async () => {
      const { policy, jobId } = await fixtureSubmittedJob();
      // fast-forward beyond disputeWindow
      await testClient.increaseTime({ seconds: Number(DISPUTE_WINDOW_SECONDS) + 1 });
      await testClient.mine({ blocks: 1 });
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await assert.rejects(policyAsClient.write.dispute([jobId]));
    });

    it("reverts on duplicate dispute", async () => {
      const { policy, jobId } = await fixtureSubmittedJob();
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await policyAsClient.write.dispute([jobId]);
      await assert.rejects(policyAsClient.write.dispute([jobId]));
    });
  });

  describe("voteReject", () => {
    async function fixtureDisputedJob() {
      // reuse dispute fixture
      const f = await deployACPAndRouter();
      const policy = await deployPolicy(f.apex.address, f.router.address);
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([policy.address, true]);

      const pc = await viem.getPublicClient();
      const block = await pc.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", f.apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        f.router.address,
        expiredAt,
        "job",
        zeroAddress,
      ]);
      const jobId = await f.apex.read.jobCounter();
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, policy.address]);
      await apexAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]);
      await f.token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", f.token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([f.apex.address, DEFAULT_BUDGET]);
      await apexAsClient.write.fund([jobId, DEFAULT_BUDGET, "0x"]);
      const apexAsProvider = await viem.getContractAt(
        "AgenticCommerceUpgradeable",
        f.apex.address,
        { client: { wallet: provider } },
      );
      await apexAsProvider.write.submit([jobId, keccak256("0xdead"), "0x"]);
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await policyAsClient.write.dispute([jobId]);
      return { ...f, policy, jobId };
    }

    it("voter can vote reject; rejectVotes increments", async () => {
      const { policy, jobId } = await fixtureDisputedJob();
      const policyAsV1 = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: v1 },
      });
      await policyAsV1.write.voteReject([jobId]);
      assert.equal(await policy.read.rejectVotes([jobId]), 1);
      assert.equal(await policy.read.voted([jobId, voterAddrs[0]]), true);
    });

    it("reverts if not a voter", async () => {
      const { policy, jobId } = await fixtureDisputedJob();
      const policyAsStranger = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: stranger },
      });
      await assert.rejects(policyAsStranger.write.voteReject([jobId]));
    });

    it("reverts if not disputed", async () => {
      // create a brand new submitted-but-not-disputed job
      const { apex, router, policy } = await fixtureDisputedJob();
      const pc = await viem.getPublicClient();
      const block = await pc.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        router.address,
        expiredAt,
        "j2",
        zeroAddress,
      ]);
      const jobId2 = await apex.read.jobCounter();

      const policyAsV1 = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: v1 },
      });
      await assert.rejects(policyAsV1.write.voteReject([jobId2]));
    });

    it("reverts on duplicate vote by same voter", async () => {
      const { policy, jobId } = await fixtureDisputedJob();
      const policyAsV1 = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: v1 },
      });
      await policyAsV1.write.voteReject([jobId]);
      await assert.rejects(policyAsV1.write.voteReject([jobId]));
    });

    it("multiple voters can vote", async () => {
      const { policy, jobId } = await fixtureDisputedJob();
      for (const w of [v1, v2, v3]) {
        const p = await viem.getContractAt("OptimisticPolicy", policy.address, {
          client: { wallet: w },
        });
        await p.write.voteReject([jobId]);
      }
      assert.equal(await policy.read.rejectVotes([jobId]), 3);
    });

    it("emits QuorumReached exactly once, on the threshold vote", async () => {
      const { policy, jobId } = await fixtureDisputedJob();

      async function vote(wallet: any) {
        const p = await viem.getContractAt("OptimisticPolicy", policy.address, {
          client: { wallet },
        });
        const tx = await p.write.voteReject([jobId]);
        return publicClient.waitForTransactionReceipt({ hash: tx });
      }

      // Pre-quorum votes (1 and 2) must NOT emit QuorumReached.
      const r1 = await vote(v1);
      const r2 = await vote(v2);
      for (const r of [r1, r2]) {
        const logs = await publicClient.getContractEvents({
          address: policy.address,
          abi: policy.abi,
          eventName: "QuorumReached",
          fromBlock: r.blockNumber,
          toBlock: r.blockNumber,
        });
        assert.equal(logs.length, 0);
      }

      // Threshold vote (3rd) emits exactly one QuorumReached.
      const r3 = await vote(v3);
      const quorumLogs = await publicClient.getContractEvents({
        address: policy.address,
        abi: policy.abi,
        eventName: "QuorumReached",
        fromBlock: r3.blockNumber,
        toBlock: r3.blockNumber,
      });
      assert.equal(quorumLogs.length, 1);
      assert.equal(quorumLogs[0].args.jobId, jobId);
      assert.equal(quorumLogs[0].args.voteCount, VOTE_QUORUM);

      // Post-quorum votes (4th) must NOT emit QuorumReached again.
      const r4 = await vote(v4);
      const postQuorumLogs = await publicClient.getContractEvents({
        address: policy.address,
        abi: policy.abi,
        eventName: "QuorumReached",
        fromBlock: r4.blockNumber,
        toBlock: r4.blockNumber,
      });
      assert.equal(postQuorumLogs.length, 0);
    });
  });

  describe("check", () => {
    async function fixtureSubmittedJobForCheck() {
      const f = await deployACPAndRouter();
      const policy = await deployPolicy(f.apex.address, f.router.address);
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([policy.address, true]);
      const pc = await viem.getPublicClient();
      const block = await pc.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", f.apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        f.router.address,
        expiredAt,
        "job",
        zeroAddress,
      ]);
      const jobId = await f.apex.read.jobCounter();
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, policy.address]);
      await apexAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]);
      await f.token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", f.token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([f.apex.address, DEFAULT_BUDGET]);
      await apexAsClient.write.fund([jobId, DEFAULT_BUDGET, "0x"]);
      const apexAsProvider = await viem.getContractAt(
        "AgenticCommerceUpgradeable",
        f.apex.address,
        { client: { wallet: provider } },
      );
      await apexAsProvider.write.submit([jobId, keccak256("0xdead"), "0x"]);
      return { ...f, policy, jobId };
    }

    it("reverts if called by non-router", async () => {
      const { policy, jobId } = await fixtureSubmittedJobForCheck();
      await assert.rejects(policy.read.check([jobId, "0x"]));
    });

    // Full check() path coverage is exercised via the router settle tests in Phase 4 and
    // end-to-end lifecycle tests in Phase 6. The policy-level test below exercises the
    // view result via low-level staticcall.
    it("returns Pending when neither approve nor reject condition met", async () => {
      const { router, policy, jobId } = await fixtureSubmittedJobForCheck();
      // simulate calling check() from the router address using a low-level impersonation
      await testClient.impersonateAccount({ address: router.address });
      const [verdict] = await policy.read.check([jobId, "0x"], { account: router.address });
      assert.equal(verdict, Verdict.Pending);
      await testClient.stopImpersonatingAccount({ address: router.address });
    });

    it("returns Approve when !disputed and window elapsed", async () => {
      const { router, policy, jobId } = await fixtureSubmittedJobForCheck();
      await testClient.increaseTime({ seconds: Number(DISPUTE_WINDOW_SECONDS) });
      await testClient.mine({ blocks: 1 });
      await testClient.impersonateAccount({ address: router.address });
      const [verdict] = await policy.read.check([jobId, "0x"], { account: router.address });
      assert.equal(verdict, Verdict.Approve);
      await testClient.stopImpersonatingAccount({ address: router.address });
    });

    it("returns Reject when disputed and votes >= quorum", async () => {
      const { router, policy, jobId } = await fixtureSubmittedJobForCheck();
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await policyAsClient.write.dispute([jobId]);
      for (const w of [v1, v2, v3]) {
        const p = await viem.getContractAt("OptimisticPolicy", policy.address, {
          client: { wallet: w },
        });
        await p.write.voteReject([jobId]);
      }
      await testClient.impersonateAccount({ address: router.address });
      const [verdict] = await policy.read.check([jobId, "0x"], { account: router.address });
      assert.equal(verdict, Verdict.Reject);
      await testClient.stopImpersonatingAccount({ address: router.address });
    });

    it("returns Pending when disputed but votes < quorum even after window", async () => {
      const { router, policy, jobId } = await fixtureSubmittedJobForCheck();
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await policyAsClient.write.dispute([jobId]);
      const p = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: v1 },
      });
      await p.write.voteReject([jobId]); // only 1 vote

      await testClient.increaseTime({ seconds: Number(DISPUTE_WINDOW_SECONDS) + 10 });
      await testClient.mine({ blocks: 1 });

      await testClient.impersonateAccount({ address: router.address });
      const [verdict] = await policy.read.check([jobId, "0x"], { account: router.address });
      assert.equal(verdict, Verdict.Pending);
      await testClient.stopImpersonatingAccount({ address: router.address });
    });
  });

  describe("voter admin", () => {
    it("addVoter increments activeVoterCount and flags isVoter", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      const policyAsAdmin = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: adminEoa },
      });
      const newVoter = getAddress(stranger.account.address);
      await policyAsAdmin.write.addVoter([newVoter]);
      assert.equal(await policy.read.isVoter([newVoter]), true);
      assert.equal(await policy.read.activeVoterCount(), voterAddrs.length + 1);
    });

    it("addVoter reverts on duplicate and zero", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      const policyAsAdmin = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: adminEoa },
      });
      await assert.rejects(policyAsAdmin.write.addVoter([voterAddrs[0]]));
      await assert.rejects(policyAsAdmin.write.addVoter([zeroAddress]));
    });

    it("removeVoter decrements and guards against dropping below quorum", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address); // 5 voters, quorum 3
      const policyAsAdmin = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: adminEoa },
      });
      // Remove 2 → 3 remaining (== quorum, OK)
      await policyAsAdmin.write.removeVoter([voterAddrs[0]]);
      await policyAsAdmin.write.removeVoter([voterAddrs[1]]);
      assert.equal(await policy.read.activeVoterCount(), 3);
      // Removing one more → 2 remaining < quorum 3 → revert
      await assert.rejects(policyAsAdmin.write.removeVoter([voterAddrs[2]]));
    });

    it("removeVoter reverts when address is not a voter", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      const policyAsAdmin = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: adminEoa },
      });
      await assert.rejects(policyAsAdmin.write.removeVoter([getAddress(stranger.account.address)]));
    });

    it("historical votes from removed voter still count", async () => {
      const { apex, router, token } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([policy.address, true]);
      // create + register + submit
      const pc = await viem.getPublicClient();
      const block = await pc.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        router.address,
        expiredAt,
        "j",
        zeroAddress,
      ]);
      const jobId = await apex.read.jobCounter();
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, policy.address]);
      await apexAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);
      await apexAsClient.write.fund([jobId, DEFAULT_BUDGET, "0x"]);
      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256("0x01"), "0x"]);

      // dispute + 3 reject votes
      const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: client },
      });
      await policyAsClient.write.dispute([jobId]);
      for (const w of [v1, v2, v3]) {
        const p = await viem.getContractAt("OptimisticPolicy", policy.address, {
          client: { wallet: w },
        });
        await p.write.voteReject([jobId]);
      }
      assert.equal(await policy.read.rejectVotes([jobId]), 3);

      // admin removes v1 (but we still have v2 v3 v4 v5 = 4 >= quorum 3, so allowed)
      const policyAsAdmin = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: adminEoa },
      });
      await policyAsAdmin.write.removeVoter([voterAddrs[0]]);

      // rejectVotes should still be 3
      assert.equal(await policy.read.rejectVotes([jobId]), 3);
      assert.equal(await policy.read.activeVoterCount(), 4);
    });

    it("transferAdmin switches admin", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      const policyAsAdmin = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: adminEoa },
      });
      const newAdmin = getAddress(stranger.account.address);
      await policyAsAdmin.write.transferAdmin([newAdmin]);
      assert.equal(getAddress(await policy.read.admin()), newAdmin);

      // old admin can no longer addVoter
      await assert.rejects(policyAsAdmin.write.addVoter([getAddress(client.account.address)]));
    });

    it("non-admin cannot call voter management", async () => {
      const { apex, router } = await deployACPAndRouter();
      const policy = await deployPolicy(apex.address, router.address);
      const policyAsStranger = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: stranger },
      });
      await assert.rejects(policyAsStranger.write.addVoter([getAddress(stranger.account.address)]));
      await assert.rejects(policyAsStranger.write.removeVoter([voterAddrs[0]]));
      await assert.rejects(
        policyAsStranger.write.transferAdmin([getAddress(stranger.account.address)]),
      );
    });
  });
});
