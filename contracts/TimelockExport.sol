// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Re-export so Hardhat generates the TimelockController artifact we use from scripts.
import {TimelockController as _TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

// Concrete wrapper so Hardhat emits a deployable TimelockController artifact.
// Never instantiate directly in production — use scripts/gov/runbooks/deploy-timelock.ts.
// solhint-disable-next-line no-empty-blocks
contract TimelockController is _TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) _TimelockController(minDelay, proposers, executors, admin) {}
}
