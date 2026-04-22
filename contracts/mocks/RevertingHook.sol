// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IACPHook} from "../IACPHook.sol";

/// @dev Test-only hook used to prove that `claimRefund` is the non-hookable
///      escape hatch. The hook has an `armed` flag:
///      - disarmed (default): every callback is a no-op, so the job can be
///        created / funded normally.
///      - armed: every callback reverts, so any kernel action that still
///        dispatches a hook would propagate that revert.
///      The test arms the hook after funding; if `claimRefund` ever invoked
///      `beforeAction` / `afterAction`, the refund call would fail.
contract RevertingHook is IACPHook {
    error HookCalled();

    bool public armed;

    function arm() external {
        armed = true;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external view {
        if (armed) revert HookCalled();
    }

    function afterAction(uint256, bytes4, bytes calldata) external view {
        if (armed) revert HookCalled();
    }
}
