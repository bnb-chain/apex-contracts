import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, zeroAddress } from "viem";
import { JobStatus, DEFAULT_BUDGET, DISPUTE_WINDOW_SECONDS, VOTE_QUORUM } from "./constants.js";
import { deployMockToken, deployAPEXProxy } from "./deploy.js";

describe("Router + Policy lifecycle", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const [deployer, client, provider, adminEoa, treasury, v1, v2, v3, v4, v5, settler] =
    await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const adminAddress = getAddress(adminEoa.account.address);
  const treasuryAddress = getAddress(treasury.account.address);
  const voterAddrs = [v1, v2, v3, v4, v5].map((w) => getAddress(w.account.address));

  async function deployV1Stack() {
    const token = await deployMockToken(viem);
    const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);
    const router = await viem.deployContract("EvaluatorRouter", [apex.address, adminAddress]);
    const policy = await viem.deployContract("OptimisticPolicy", [
      apex.address,
      router.address,
      DISPUTE_WINDOW_SECONDS,
      VOTE_QUORUM,
      adminAddress,
      voterAddrs,
    ]);
    // admin whitelists policy
    const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: adminEoa },
    });
    await routerAsAdmin.write.setPolicyWhitelist([policy.address, true]);
    return { token, apex, router, policy };
  }

  async function createAndRegisterJob(
    apex: any,
    router: any,
    policy: any,
    expiredAtOverride?: bigint,
  ): Promise<bigint> {
    const block = await publicClient.getBlock();
    const expiredAt = expiredAtOverride ?? block.timestamp + BigInt(30 * 86400);
    const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: client },
    });
    await apexAsClient.write.createJob([
      providerAddress,
      router.address,
      expiredAt,
      "lifecycle job",
      zeroAddress,
    ]);
    const jobId = await apex.read.jobCounter();
    const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: client },
    });
    await routerAsClient.write.registerJob([jobId, policy.address]);
    return jobId;
  }

  async function fundAndSubmit(apex: any, token: any, jobId: bigint) {
    const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: client },
    });
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
    await apexAsProvider.write.submit([jobId, keccak256("0xdeliverable"), "0x"]);
  }

  // -- Flow tests below --

  it("Flow A · Happy: silence → auto-approve, provider paid", async () => {
    const { token, apex, router, policy } = await deployV1Stack();
    const jobId = await createAndRegisterJob(apex, router, policy);
    await fundAndSubmit(apex, token, jobId);

    // Fast-forward past dispute window
    await testClient.increaseTime({ seconds: Number(DISPUTE_WINDOW_SECONDS) });
    await testClient.mine({ blocks: 1 });

    const providerBalBefore = await token.read.balanceOf([providerAddress]);

    // anyone can settle
    const routerAsSettler = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: settler },
    });
    await routerAsSettler.write.settle([jobId, "0x"]);

    const providerBalAfter = await token.read.balanceOf([providerAddress]);
    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Completed);
    // Provider received net of any platform/eval fee; since fees default to 0 in this test,
    // full budget should reach provider
    assert.equal(providerBalAfter - providerBalBefore, DEFAULT_BUDGET);
  });

  it("Flow B · Dispute + quorum reject: client refunded", async () => {
    const { token, apex, router, policy } = await deployV1Stack();
    const jobId = await createAndRegisterJob(apex, router, policy);
    await fundAndSubmit(apex, token, jobId);

    // Client disputes
    const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
      client: { wallet: client },
    });
    await policyAsClient.write.dispute([jobId]);

    // 3 voters reject
    for (const w of [v1, v2, v3]) {
      const p = await viem.getContractAt("OptimisticPolicy", policy.address, {
        client: { wallet: w },
      });
      await p.write.voteReject([jobId]);
    }

    const clientBalBefore = await token.read.balanceOf([clientAddress]);
    const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: client },
    });
    await routerAsClient.write.settle([jobId, "0x"]);
    const clientBalAfter = await token.read.balanceOf([clientAddress]);

    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Rejected);
    assert.equal(clientBalAfter - clientBalBefore, DEFAULT_BUDGET);
  });

  it("Flow B · reject can settle before window elapses (quorum-based)", async () => {
    const { token, apex, router, policy } = await deployV1Stack();
    const jobId = await createAndRegisterJob(apex, router, policy);
    await fundAndSubmit(apex, token, jobId);

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

    // immediately settle — no time advancement
    const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: client },
    });
    await routerAsClient.write.settle([jobId, "0x"]);

    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Rejected);
  });

  it("Flow C · Stalemate: dispute but insufficient votes → claimRefund at expiredAt", async () => {
    const { token, apex, router, policy } = await deployV1Stack();
    const pc = await viem.getPublicClient();
    const block = await pc.getBlock();
    const expiredAt = block.timestamp + BigInt(30 * 86400);
    const jobId = await createAndRegisterJob(apex, router, policy, expiredAt);
    await fundAndSubmit(apex, token, jobId);

    const policyAsClient = await viem.getContractAt("OptimisticPolicy", policy.address, {
      client: { wallet: client },
    });
    await policyAsClient.write.dispute([jobId]);
    // only 1 vote, not enough
    const pv1 = await viem.getContractAt("OptimisticPolicy", policy.address, {
      client: { wallet: v1 },
    });
    await pv1.write.voteReject([jobId]);

    // advance past window — settle still reverts because disputed blocks rule 2
    await testClient.increaseTime({ seconds: Number(DISPUTE_WINDOW_SECONDS) + 10 });
    await testClient.mine({ blocks: 1 });

    const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: client },
    });
    await assert.rejects(routerAsClient.write.settle([jobId, "0x"]));

    // advance past expiredAt
    await testClient.setNextBlockTimestamp({ timestamp: expiredAt + BigInt(1) });
    await testClient.mine({ blocks: 1 });

    const clientBalBefore = await token.read.balanceOf([clientAddress]);
    const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: client },
    });
    await apexAsClient.write.claimRefund([jobId]);
    const clientBalAfter = await token.read.balanceOf([clientAddress]);

    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Expired);
    assert.equal(clientBalAfter - clientBalBefore, DEFAULT_BUDGET);
  });

  it("Flow D · Open cancel: client rejects before fund", async () => {
    const { apex, router, policy } = await deployV1Stack();
    const jobId = await createAndRegisterJob(apex, router, policy);

    const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: client },
    });
    await apexAsClient.write.reject([jobId, keccak256("0xcancel"), "0x"]);

    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Rejected);
  });

  it("Flow E · Funded but no submit: claimRefund at expiredAt", async () => {
    const { token, apex, router, policy } = await deployV1Stack();
    const pc = await viem.getPublicClient();
    const block = await pc.getBlock();
    const expiredAt = block.timestamp + BigInt(7 * 86400);
    const jobId = await createAndRegisterJob(apex, router, policy, expiredAt);

    // fund but don't submit
    const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: client },
    });
    await apexAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]);
    await token.write.mint([clientAddress, DEFAULT_BUDGET]);
    const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
      client: { wallet: client },
    });
    await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);
    await apexAsClient.write.fund([jobId, DEFAULT_BUDGET, "0x"]);

    // fast-forward past expiredAt
    await testClient.setNextBlockTimestamp({ timestamp: expiredAt + BigInt(1) });
    await testClient.mine({ blocks: 1 });

    const clientBalBefore = await token.read.balanceOf([clientAddress]);
    await apexAsClient.write.claimRefund([jobId]);
    const clientBalAfter = await token.read.balanceOf([clientAddress]);

    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Expired);
    assert.equal(clientBalAfter - clientBalBefore, DEFAULT_BUDGET);
  });

  it("Flow F · Forgot registerJob: settle reverts forever → claimRefund at expiredAt", async () => {
    const { token, apex, router } = await deployV1Stack(); // policy deployed but NOT registered per-job
    const pc = await viem.getPublicClient();
    const block = await pc.getBlock();
    const expiredAt = block.timestamp + BigInt(7 * 86400);
    const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: client },
    });
    await apexAsClient.write.createJob([
      providerAddress,
      router.address,
      expiredAt,
      "forgot",
      zeroAddress,
    ]);
    const jobId = await apex.read.jobCounter();

    // NOTE: client did NOT call registerJob
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
    await apexAsProvider.write.submit([jobId, keccak256("0xdel"), "0x"]);

    // try to settle — should revert "not registered"
    const routerAsSettler = await viem.getContractAt("EvaluatorRouter", router.address, {
      client: { wallet: settler },
    });
    await assert.rejects(routerAsSettler.write.settle([jobId, "0x"]));

    // only way out: claimRefund after expiredAt
    await testClient.setNextBlockTimestamp({ timestamp: expiredAt + BigInt(1) });
    await testClient.mine({ blocks: 1 });

    const clientBalBefore = await token.read.balanceOf([clientAddress]);
    await apexAsClient.write.claimRefund([jobId]);
    const clientBalAfter = await token.read.balanceOf([clientAddress]);

    const job = await apex.read.getJob([jobId]);
    assert.equal(job.status, JobStatus.Expired);
    assert.equal(clientBalAfter - clientBalBefore, DEFAULT_BUDGET);
  });
});
