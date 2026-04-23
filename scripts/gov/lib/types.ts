import type { network } from "hardhat";
import type { DeployedAddresses } from "../../addresses.js";

export type AnyViem = Awaited<ReturnType<typeof network.connect>>["viem"];

export type ExecMode = "eoa" | "calldata" | "propose" | "dry-run";

export type CallItem = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  description: string;
};

export type GovContext = {
  cfg: DeployedAddresses;
  networkName: string;
  deployer: `0x${string}`;
  mode: ExecMode;
  viem: AnyViem;
};
