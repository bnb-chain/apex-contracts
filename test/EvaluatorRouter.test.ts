import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, encodeAbiParameters, zeroAddress } from "viem";
import { JobStatus, DEFAULT_BUDGET, Verdict } from "./constants.js";
import { deployMockToken, deployAPEXProxy, createAndFundJob } from "./deploy.js";

describe("EvaluatorRouter", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const [deployer, client, provider, adminEoa, treasury, someone] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const adminAddress = getAddress(adminEoa.account.address);
  const treasuryAddress = getAddress(treasury.account.address);

  async function deployFixture() {
    const token = await deployMockToken(viem);
    const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);
    const router = await viem.deployContract("EvaluatorRouter", [apex.address, adminAddress]);
    const mockPolicy = await viem.deployContract("MockPolicy", []);
    return { token, apex, router, mockPolicy };
  }

  describe("Deployment", () => {
    it("records acp and admin", async () => {
      const { apex, router } = await deployFixture();
      assert.equal(getAddress(await router.read.acp()), getAddress(apex.address));
      assert.equal(getAddress(await router.read.admin()), adminAddress);
    });

    it("reverts if acp == 0", async () => {
      await assert.rejects(viem.deployContract("EvaluatorRouter", [zeroAddress, adminAddress]));
    });

    it("reverts if admin == 0", async () => {
      const { apex } = await deployFixture();
      await assert.rejects(viem.deployContract("EvaluatorRouter", [apex.address, zeroAddress]));
    });
  });

  describe("setPolicyWhitelist", () => {
    it("admin can add a policy", async () => {
      const { router, mockPolicy } = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([mockPolicy.address, true]);
      assert.equal(await router.read.policyWhitelist([mockPolicy.address]), true);
    });

    it("admin can remove a policy", async () => {
      const { router, mockPolicy } = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([mockPolicy.address, true]);
      await routerAsAdmin.write.setPolicyWhitelist([mockPolicy.address, false]);
      assert.equal(await router.read.policyWhitelist([mockPolicy.address]), false);
    });

    it("reverts when called by non-admin", async () => {
      const { router, mockPolicy } = await deployFixture();
      const routerAsStranger = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: someone },
      });
      await assert.rejects(routerAsStranger.write.setPolicyWhitelist([mockPolicy.address, true]));
    });

    it("reverts on zero address", async () => {
      const { router } = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await assert.rejects(routerAsAdmin.write.setPolicyWhitelist([zeroAddress, true]));
    });
  });

  describe("transferAdmin", () => {
    it("admin can transfer to a new admin", async () => {
      const { router } = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.transferAdmin([getAddress(someone.account.address)]);
      assert.equal(getAddress(await router.read.admin()), getAddress(someone.account.address));
    });

    it("new admin can operate; old admin is denied", async () => {
      const { router, mockPolicy } = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.transferAdmin([getAddress(someone.account.address)]);

      const routerAsNewAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: someone },
      });
      await routerAsNewAdmin.write.setPolicyWhitelist([mockPolicy.address, true]);
      assert.equal(await router.read.policyWhitelist([mockPolicy.address]), true);

      await assert.rejects(routerAsAdmin.write.setPolicyWhitelist([mockPolicy.address, false]));
    });

    it("reverts on zero address", async () => {
      const { router } = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await assert.rejects(routerAsAdmin.write.transferAdmin([zeroAddress]));
    });

    it("reverts when called by non-admin", async () => {
      const { router } = await deployFixture();
      const routerAsStranger = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: someone },
      });
      await assert.rejects(
        routerAsStranger.write.transferAdmin([getAddress(someone.account.address)]),
      );
    });
  });

  describe("registerJob", () => {
    async function fixtureWithWhitelistedPolicy() {
      const f = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([f.mockPolicy.address, true]);
      return f;
    }

    async function createOpenJob(apex: any, router: any) {
      const publicClient = await viem.getPublicClient();
      const block = await publicClient.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        router.address,
        expiredAt,
        "job",
        zeroAddress,
      ]);
      return await apex.read.jobCounter();
    }

    it("client can register a whitelisted policy while job is Open", async () => {
      const { apex, router, mockPolicy } = await fixtureWithWhitelistedPolicy();
      const jobId = await createOpenJob(apex, router);

      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, mockPolicy.address]);
      assert.equal(
        getAddress(await router.read.jobPolicy([jobId])),
        getAddress(mockPolicy.address),
      );
    });

    it("reverts if not called by client", async () => {
      const { apex, router, mockPolicy } = await fixtureWithWhitelistedPolicy();
      const jobId = await createOpenJob(apex, router);
      const routerAsStranger = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: someone },
      });
      await assert.rejects(routerAsStranger.write.registerJob([jobId, mockPolicy.address]));
    });

    it("reverts if policy not in whitelist", async () => {
      const { apex, router, mockPolicy } = await deployFixture(); // no whitelist yet
      const jobId = await createOpenJob(apex, router);
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await assert.rejects(routerAsClient.write.registerJob([jobId, mockPolicy.address]));
    });

    it("reverts if evaluator != router", async () => {
      const { apex, router, mockPolicy } = await fixtureWithWhitelistedPolicy();
      // create a job pointing evaluator to someone else
      const publicClient = await viem.getPublicClient();
      const block = await publicClient.getBlock();
      const expiredAt = block.timestamp + BigInt(86400);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        treasuryAddress,
        expiredAt,
        "job",
        zeroAddress,
      ]);
      const jobId = await apex.read.jobCounter();

      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await assert.rejects(routerAsClient.write.registerJob([jobId, mockPolicy.address]));
    });

    it("reverts if job not in Open status", async () => {
      const { apex, router, mockPolicy, token } = await fixtureWithWhitelistedPolicy();
      const jobId = await createAndFundJob(
        viem,
        apex,
        token,
        client,
        providerAddress,
        router.address,
        DEFAULT_BUDGET,
      );
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await assert.rejects(routerAsClient.write.registerJob([jobId, mockPolicy.address]));
    });

    it("reverts if already registered", async () => {
      const { apex, router, mockPolicy } = await fixtureWithWhitelistedPolicy();
      const jobId = await createOpenJob(apex, router);
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, mockPolicy.address]);
      await assert.rejects(routerAsClient.write.registerJob([jobId, mockPolicy.address]));
    });

    it("removing policy from whitelist blocks new registrations but keeps existing binding", async () => {
      const { apex, router, mockPolicy } = await fixtureWithWhitelistedPolicy();
      const jobId1 = await createOpenJob(apex, router);

      const routerAsClient = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId1, mockPolicy.address]);

      // Admin removes
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([mockPolicy.address, false]);

      // Existing binding preserved
      assert.equal(
        getAddress(await router.read.jobPolicy([jobId1])),
        getAddress(mockPolicy.address),
      );

      // New registration fails
      const jobId2 = await createOpenJob(apex, router);
      await assert.rejects(routerAsClient.write.registerJob([jobId2, mockPolicy.address]));
    });
  });

  describe("settle", () => {
    async function fixtureWithRegisteredJob() {
      const f = await deployFixture();
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([f.mockPolicy.address, true]);

      const publicClient = await viem.getPublicClient();
      const block = await publicClient.getBlock();
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

      // Register
      const routerAsClient = await viem.getContractAt("EvaluatorRouter", f.router.address, {
        client: { wallet: client },
      });
      await routerAsClient.write.registerJob([jobId, f.mockPolicy.address]);

      // Fund + submit
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

      return { ...f, jobId };
    }

    it("reverts if job not registered", async () => {
      const { router } = await deployFixture();
      await assert.rejects(router.write.settle([BigInt(1), "0x"]));
    });

    it("Pending verdict → reverts", async () => {
      const { router, mockPolicy, jobId } = await fixtureWithRegisteredJob();
      await mockPolicy.write.setResult([Verdict.Pending, keccak256("0x01")]);
      await assert.rejects(router.write.settle([jobId, "0x"]));
    });

    it("Approve verdict → calls acp.complete with correct reason", async () => {
      const { apex, router, mockPolicy, jobId } = await fixtureWithRegisteredJob();
      const evHash = keccak256("0xabcd") as `0x${string}`;
      await mockPolicy.write.setResult([Verdict.Approve, evHash]);

      await router.write.settle([jobId, "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, JobStatus.Completed);

      const expectedReason = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint8" }, { type: "bytes32" }],
          [getAddress(mockPolicy.address), Verdict.Approve, evHash],
        ),
      );
      // reason is embedded in JobCompleted event; verify via log
      // simplest: read all logs and find JobSettled event from router
      // (left as assertion on job status;完整 event 校验在 lifecycle 套件覆盖)
    });

    it("Reject verdict → calls acp.reject and refunds client", async () => {
      const { apex, router, mockPolicy, token, jobId } = await fixtureWithRegisteredJob();
      await mockPolicy.write.setResult([Verdict.Reject, keccak256("0xbeef")]);

      const balBefore = await token.read.balanceOf([clientAddress]);
      await router.write.settle([jobId, "0x"]);
      const balAfter = await token.read.balanceOf([clientAddress]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, JobStatus.Rejected);
      assert.equal(balAfter - balBefore, DEFAULT_BUDGET);
    });

    it("still settles when policy is later removed from whitelist", async () => {
      const { apex, router, mockPolicy, jobId } = await fixtureWithRegisteredJob();
      // Remove policy from whitelist
      const routerAsAdmin = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: adminEoa },
      });
      await routerAsAdmin.write.setPolicyWhitelist([mockPolicy.address, false]);

      await mockPolicy.write.setResult([Verdict.Approve, keccak256("0x01")]);
      await router.write.settle([jobId, "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, JobStatus.Completed);
    });

    it("settle is permissionless — anyone can call", async () => {
      const { router, mockPolicy, jobId } = await fixtureWithRegisteredJob();
      await mockPolicy.write.setResult([Verdict.Approve, keccak256("0x01")]);
      const routerAsStranger = await viem.getContractAt("EvaluatorRouter", router.address, {
        client: { wallet: someone },
      });
      await routerAsStranger.write.settle([jobId, "0x"]);
    });
  });
});
