// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPolicy} from "../IPolicy.sol";

/// @title RecordingPolicyMock
/// @notice Test-only policy: records the exact arguments the Router forwards
///         to {onSubmitted} so transport of `optParams` can be asserted in
///         unit tests. Verdicts are configurable at deploy time.
/// @dev    Not deployed to any live network.
contract RecordingPolicyMock is IPolicy {
    bytes32 public lastDeliverable;
    bytes public lastOptParams;
    uint256 public lastJobId;
    uint256 public onSubmittedCalls;

    uint8 public verdict;
    bytes32 public reason;

    constructor(uint8 verdict_, bytes32 reason_) {
        verdict = verdict_;
        reason = reason_;
    }

    function onSubmitted(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external override {
        lastJobId = jobId;
        lastDeliverable = deliverable;
        lastOptParams = optParams;
        onSubmittedCalls += 1;
    }

    function check(uint256 /* jobId */, bytes calldata /* evidence */) external view override returns (uint8, bytes32) {
        return (verdict, reason);
    }
}
