// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IACP
/// @notice Internal contract between APEX Router/Policy and AgenticCommerce kernel.
///         NOT an ERC-8183 subset; third-party kernels need an adapter.
interface IACP {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct Job {
        uint256   id;
        address   client;
        address   provider;
        address   evaluator;
        string    description;
        uint256   budget;
        uint256   expiredAt;
        JobStatus status;
        address   hook;
        uint64    submittedAt;
    }

    function getJob(uint256 jobId) external view returns (Job memory);
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
