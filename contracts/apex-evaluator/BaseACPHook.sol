// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IACPHook.sol";

abstract contract BaseACPHook is IACPHook {
    address public immutable acp;

    error OnlyACP();

    modifier onlyACP() {
        if (msg.sender != acp) revert OnlyACP();
        _;
    }

    constructor(address _acp) {
        require(_acp != address(0), "invalid acp");
        acp = _acp;
    }

    // ============================================================
    //  IERC165
    // ============================================================

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IACPHook).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    // ============================================================
    //  Function Selectors
    // ============================================================

    bytes4 private constant SET_PROVIDER_SELECTOR =
        bytes4(keccak256("setProvider(uint256,address,bytes)"));
    bytes4 private constant SET_BUDGET_SELECTOR =
        bytes4(keccak256("setBudget(uint256,uint256,bytes)"));
    bytes4 private constant FUND_SELECTOR =
        bytes4(keccak256("fund(uint256,uint256,bytes)"));
    bytes4 private constant SUBMIT_SELECTOR =
        bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 private constant COMPLETE_SELECTOR =
        bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    bytes4 private constant REJECT_SELECTOR =
        bytes4(keccak256("reject(uint256,bytes32,bytes)"));

    // ============================================================
    //  IACPHook Implementation
    // ============================================================

    function beforeAction(
        uint256 jobId, bytes4 selector, bytes calldata data
    ) external onlyACP {
        if (selector == SET_PROVIDER_SELECTOR) _beforeSetProvider(jobId, data);
        else if (selector == SET_BUDGET_SELECTOR) _beforeSetBudget(jobId, data);
        else if (selector == FUND_SELECTOR) _beforeFund(jobId, data);
        else if (selector == SUBMIT_SELECTOR) _beforeSubmit(jobId, data);
        else if (selector == COMPLETE_SELECTOR) _beforeComplete(jobId, data);
        else if (selector == REJECT_SELECTOR) _beforeReject(jobId, data);
    }

    function afterAction(
        uint256 jobId, bytes4 selector, bytes calldata data
    ) external onlyACP {
        if (selector == SET_PROVIDER_SELECTOR) _afterSetProvider(jobId, data);
        else if (selector == SET_BUDGET_SELECTOR) _afterSetBudget(jobId, data);
        else if (selector == FUND_SELECTOR) _afterFund(jobId, data);
        else if (selector == SUBMIT_SELECTOR) _afterSubmit(jobId, data);
        else if (selector == COMPLETE_SELECTOR) _afterComplete(jobId, data);
        else if (selector == REJECT_SELECTOR) _afterReject(jobId, data);
    }

    // ============================================================
    //  Virtual Functions — Before Hooks
    // ============================================================

    function _beforeSetProvider(uint256 jobId, bytes calldata data) internal virtual {}
    function _beforeSetBudget(uint256 jobId, bytes calldata data) internal virtual {}
    function _beforeFund(uint256 jobId, bytes calldata data) internal virtual {}
    function _beforeSubmit(uint256 jobId, bytes calldata data) internal virtual {}
    function _beforeComplete(uint256 jobId, bytes calldata data) internal virtual {}
    function _beforeReject(uint256 jobId, bytes calldata data) internal virtual {}

    // ============================================================
    //  Virtual Functions — After Hooks
    // ============================================================

    function _afterSetProvider(uint256 jobId, bytes calldata data) internal virtual {}
    function _afterSetBudget(uint256 jobId, bytes calldata data) internal virtual {}
    function _afterFund(uint256 jobId, bytes calldata data) internal virtual {}
    function _afterSubmit(uint256 jobId, bytes calldata data) internal virtual {}
    function _afterComplete(uint256 jobId, bytes calldata data) internal virtual {}
    function _afterReject(uint256 jobId, bytes calldata data) internal virtual {}

    // ============================================================
    //  Decode Helpers
    // ============================================================

    function _decodeSetProviderData(bytes calldata data)
        internal pure returns (address provider, bytes memory optParams)
    {
        (provider, optParams) = abi.decode(data, (address, bytes));
    }

    function _decodeSetBudgetData(bytes calldata data)
        internal pure returns (uint256 amount, bytes memory optParams)
    {
        (amount, optParams) = abi.decode(data, (uint256, bytes));
    }

    function _decodeSubmitData(bytes calldata data)
        internal pure returns (bytes32 deliverable, bytes memory optParams)
    {
        (deliverable, optParams) = abi.decode(data, (bytes32, bytes));
    }

    function _decodeReasonData(bytes calldata data)
        internal pure returns (bytes32 reason, bytes memory optParams)
    {
        (reason, optParams) = abi.decode(data, (bytes32, bytes));
    }
}
