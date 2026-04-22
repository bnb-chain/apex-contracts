// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgenticCommerceUpgradeable} from "../AgenticCommerceUpgradeable.sol";

/// @dev Test-only v2 implementation of the commerce kernel. Adds a single
///      pure function so upgrade tests can distinguish v1 and v2 impls while
///      keeping the storage layout byte-for-byte identical (no new fields).
contract AgenticCommerceV2Mock is AgenticCommerceUpgradeable {
    function version() external pure returns (uint8) {
        return 2;
    }
}
