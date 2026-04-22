// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Import-only: force Hardhat to compile OZ TimelockController so deploy-timelock.ts
// can reach its artifact. No contract logic here.
import "@openzeppelin/contracts/governance/TimelockController.sol" as OZTimelock;

contract TimelockController is OZTimelock.TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) OZTimelock.TimelockController(minDelay, proposers, executors, admin) {}
}
