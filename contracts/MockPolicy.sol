// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./IPolicy.sol";

/// @title MockPolicy
/// @notice Test-only policy whose check() returns caller-controlled values.
contract MockPolicy is IPolicy {
    uint8   public nextVerdict;
    bytes32 public nextHash;

    function setResult(uint8 verdict, bytes32 hash_) external {
        nextVerdict = verdict;
        nextHash = hash_;
    }

    function check(uint256, bytes calldata)
        external view returns (uint8, bytes32)
    {
        return (nextVerdict, nextHash);
    }
}
