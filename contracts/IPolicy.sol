// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPolicy
/// @notice Minimal interface for evaluation policies called by {EvaluatorRouterUpgradeable}.
/// @dev    A policy is a pluggable strategy that decides whether a submitted job
///         should be Approved, Rejected, or remain Pending. The Router pulls the
///         verdict lazily via `check`, and notifies the policy of submission via
///         `onSubmitted` (so time-sensitive state can be initialised).
interface IPolicy {
    /// @notice Called by the Router exactly once per job, immediately after the
    ///         kernel's `submit` completes. Implementations MUST be idempotent
    ///         or revert on second call.
    /// @param jobId        Kernel job id.
    /// @param deliverable  Deliverable hash forwarded from the kernel event.
    function onSubmitted(uint256 jobId, bytes32 deliverable) external;

    /// @notice Returns the current verdict for `jobId`.
    /// @dev    MUST be `view`. Router calls this from `settle`.
    /// @param  jobId     Kernel job id.
    /// @param  evidence  Opaque policy-specific evidence (unused by
    ///                   OptimisticPolicy; reserved for future policies).
    /// @return verdict   0 = Pending, 1 = Approve, 2 = Reject.
    /// @return reason    Opaque reason code forwarded to the kernel.
    function check(uint256 jobId, bytes calldata evidence) external view returns (uint8 verdict, bytes32 reason);
}
