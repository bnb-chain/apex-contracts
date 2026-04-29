// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IACPHook} from "../IACPHook.sol";

/// @dev Test-only no-op hook. Implements {IACPHook} + ERC-165 and does nothing
///      on every callback. Used by tests that need a non-zero hook to satisfy
///      the kernel's `HookRequired` check at `createJob` but do not care about
///      hook semantics.
contract NoopHook is IACPHook {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external pure {}

    function afterAction(uint256, bytes4, bytes calldata) external pure {}
}
