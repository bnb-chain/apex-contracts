// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvaluatorRouterUpgradeable} from "../EvaluatorRouterUpgradeable.sol";

/// @dev Test-only v2 implementation of the router. Adds a single pure
///      function so upgrade tests can distinguish v1 and v2 impls while
///      keeping the ERC-7201 namespaced storage layout unchanged.
contract EvaluatorRouterV2Mock is EvaluatorRouterUpgradeable {
    function version() external pure returns (uint8) {
        return 2;
    }
}
