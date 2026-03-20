// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockOptimisticOracleV3
 * @notice Simplified mock of UMA's Optimistic Oracle V3 for testing
 * @dev Simulates assertion lifecycle: assertTruth → settle/dispute → callbacks
 */
contract MockOptimisticOracleV3 {
    using SafeERC20 for IERC20;

    struct EscalationManagerSettings {
        bool arbitrateViaEscalationManager;
        bool discardOracle;
        bool validateDisputers;
        address assertingCaller;
        address escalationManager;
    }

    struct Assertion {
        EscalationManagerSettings escalationManagerSettings;
        address asserter;
        uint64 assertionTime;
        bool settled;
        address currency;
        uint64 expirationTime;
        bool settlementResolution;
        bytes32 domainId;
        bytes32 identifier;
        uint256 bond;
        address callbackRecipient;
        address disputer;
    }

    mapping(bytes32 => Assertion) public assertions;
    uint256 private _nextAssertionId;
    uint256 public minimumBond;

    // Controls for test scenarios
    bool public autoResolveTrue;

    constructor(uint256 _minimumBond) {
        minimumBond = _minimumBond;
        autoResolveTrue = true; // Default: assertions resolve as true
    }

    function setAutoResolveTrue(bool value) external {
        autoResolveTrue = value;
    }

    function setMinimumBond(uint256 _minimumBond) external {
        minimumBond = _minimumBond;
    }

    function assertTruth(
        bytes memory,
        address asserter,
        address callbackRecipient,
        address,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId) {
        require(bond >= minimumBond, "bond too low");

        // Pull bond from caller
        currency.safeTransferFrom(msg.sender, address(this), bond);

        assertionId = keccak256(abi.encodePacked(_nextAssertionId++, block.timestamp));

        assertions[assertionId] = Assertion({
            escalationManagerSettings: EscalationManagerSettings(false, false, false, msg.sender, address(0)),
            asserter: asserter,
            assertionTime: uint64(block.timestamp),
            settled: false,
            currency: address(currency),
            expirationTime: uint64(block.timestamp) + liveness,
            settlementResolution: false,
            domainId: domainId,
            identifier: identifier,
            bond: bond,
            callbackRecipient: callbackRecipient,
            disputer: address(0)
        });
    }

    function settleAssertion(bytes32 assertionId) external {
        Assertion storage a = assertions[assertionId];
        require(a.assertionTime > 0, "assertion does not exist");
        require(!a.settled, "already settled");
        require(block.timestamp >= a.expirationTime, "not expired");

        a.settled = true;
        a.settlementResolution = autoResolveTrue;

        // Return bond to asserter on success (no dispute)
        if (a.disputer == address(0)) {
            IERC20(a.currency).safeTransfer(a.callbackRecipient, a.bond);
        }

        // Callback
        if (a.callbackRecipient != address(0)) {
            (bool success,) = a.callbackRecipient.call(
                abi.encodeWithSignature(
                    "assertionResolvedCallback(bytes32,bool)",
                    assertionId,
                    autoResolveTrue
                )
            );
            require(success, "callback failed");
        }
    }

    function disputeAssertion(bytes32 assertionId, address disputer) external {
        Assertion storage a = assertions[assertionId];
        require(a.assertionTime > 0, "assertion does not exist");
        require(!a.settled, "already settled");
        require(a.disputer == address(0), "already disputed");

        // Pull bond from disputer
        IERC20(a.currency).safeTransferFrom(msg.sender, address(this), a.bond);

        a.disputer = disputer;

        // Callback
        if (a.callbackRecipient != address(0)) {
            (bool success,) = a.callbackRecipient.call(
                abi.encodeWithSignature(
                    "assertionDisputedCallback(bytes32)",
                    assertionId
                )
            );
            require(success, "callback failed");
        }
    }

    /**
     * @notice Resolve a disputed assertion (test helper)
     * @param assertionId The assertion ID
     * @param resolveTrue Whether to resolve in asserter's favor
     */
    function resolveDispute(bytes32 assertionId, bool resolveTrue) external {
        Assertion storage a = assertions[assertionId];
        require(a.assertionTime > 0, "assertion does not exist");
        require(!a.settled, "already settled");
        require(a.disputer != address(0), "not disputed");

        a.settled = true;
        a.settlementResolution = resolveTrue;

        if (resolveTrue) {
            // Asserter wins — return 2x bond minus "oracle fee" (simplified: return 2x)
            IERC20(a.currency).safeTransfer(a.callbackRecipient, a.bond * 2);
        }
        // If !resolveTrue, disputer keeps the bond (already held by this contract)

        // Callback
        if (a.callbackRecipient != address(0)) {
            (bool success,) = a.callbackRecipient.call(
                abi.encodeWithSignature(
                    "assertionResolvedCallback(bytes32,bool)",
                    assertionId,
                    resolveTrue
                )
            );
            require(success, "callback failed");
        }
    }

    function getAssertionResult(bytes32 assertionId) external view returns (bool) {
        return assertions[assertionId].settlementResolution;
    }

    function getMinimumBond(address) external view returns (uint256) {
        return minimumBond;
    }

    function getAssertion(bytes32 assertionId) external view returns (Assertion memory) {
        return assertions[assertionId];
    }
}
