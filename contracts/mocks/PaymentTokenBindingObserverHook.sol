// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IACP} from "../IACP.sol";
import {IACPHook} from "../IACPHook.sol";

/// @dev Test-only hook that records the state and calldata visible during an
///      after-action callback.
contract PaymentTokenBindingObserverHook is IACPHook {
    IACP public immutable commerce;
    address public callbackToken;
    bytes4 public lastSelector;
    bytes public lastData;

    constructor(IACP commerce_) {
        commerce = commerce_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external pure {}

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external {
        callbackToken = commerce.jobPaymentToken(jobId);
        lastSelector = selector;
        lastData = data;
    }
}
