// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPolicy
/// @notice Stable cross-version interface between Router and Policy implementations.
///         Non-view so future policies can write state during check(); V1 implementations
///         may tighten to view.
interface IPolicy {
    /// @return verdict 0 = Pending, 1 = Approve, 2 = Reject
    /// @return evidenceHash Policy-self-reported fingerprint of the evidence used
    function check(uint256 jobId, bytes calldata evidence)
        external returns (uint8 verdict, bytes32 evidenceHash);
}
