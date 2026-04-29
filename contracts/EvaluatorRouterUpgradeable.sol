// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IACP} from "./IACP.sol";
import {IACPHook} from "./IACPHook.sol";
import {IPolicy} from "./IPolicy.sol";

/// @title EvaluatorRouterUpgradeable (v1)
/// @notice Routing layer between the ERC-8183 kernel and pluggable policies.
///         Acts simultaneously as the `job.evaluator` and `job.hook` for every
///         job registered with this Router.
///
/// @dev DEVIATES FROM ERC-8183 SHOULD: "Hooks SHOULD NOT be upgradeable after
///      a job is created." This Router is UUPS and therefore an upgradeable
///      hook for every routed job. Upgrade governance MUST be a multisig
///      behind a TimelockController; the operational default is NEVER UPGRADE.
///
/// @custom:security-contact https://bugbounty.bnbchain.org/
contract EvaluatorRouterUpgradeable is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient,
    IACPHook
{
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /// @dev `bytes4(keccak256("fund(uint256,uint256,bytes)"))`
    bytes4 internal constant FUND_SELECTOR = 0xd2e13f50;

    /// @dev `bytes4(keccak256("submit(uint256,bytes32,bytes)"))`
    bytes4 internal constant SUBMIT_SELECTOR = 0x9e63798d;

    /// @dev `IACP.complete.selector` — kept as a constant so {afterAction}
    ///      can do a tight `==` check without a `selector` lookup.
    bytes4 internal constant COMPLETE_SELECTOR = IACP.complete.selector;

    /// @dev `IACP.reject.selector`. See {COMPLETE_SELECTOR}.
    bytes4 internal constant REJECT_SELECTOR = IACP.reject.selector;

    /// @notice Verdict returned by {IPolicy.check}.
    uint8 internal constant VERDICT_PENDING = 0;
    uint8 internal constant VERDICT_APPROVE = 1;
    uint8 internal constant VERDICT_REJECT = 2;

    // ---------------------------------------------------------------
    // ERC-7201 Namespaced Storage
    // ---------------------------------------------------------------

    /// @custom:storage-location erc7201:apex.router.storage.v1
    /// @dev Append-only. Reordering or removing fields is a storage-layout
    ///      break and requires a fresh ERC-7201 namespace.
    struct RouterStorage {
        IACP commerce;
        mapping(uint256 jobId => address policy) jobPolicy;
        mapping(address policy => bool whitelisted) policyWhitelist;
        /// @notice Number of jobs currently bound to this Router whose
        ///         terminal status (Completed / Rejected / Expired) has not
        ///         yet been reflected back into Router-side bookkeeping.
        ///         Increments on {registerJob}; decrements on the kernel's
        ///         post-action callback for `complete` / `reject`, or via
        ///         {markExpired} for the non-hookable `claimRefund` path.
        ///         Gates {setCommerce} so the Router cannot be repointed at a
        ///         new kernel while jobs are still in flight (audit L03).
        uint256 jobInflightCount;
    }

    /// @dev
    ///   `keccak256(abi.encode(uint256(keccak256("apex.router.storage.v1")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant ROUTER_STORAGE_LOCATION =
        0xd24fe6f8ded0dc02fd4c1b3d293b4c9736a77276bc6ec1e37d6842d96d3e1700;

    function _router() private pure returns (RouterStorage storage $) {
        // Canonical ERC-7201 namespaced-storage accessor: assembly is the only
        // way to point a `storage` reference at an arbitrary slot.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := ROUTER_STORAGE_LOCATION
        }
    }

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event CommerceSet(address indexed oldCommerce, address indexed newCommerce);
    event PolicyWhitelisted(address indexed policy, bool indexed status);
    event JobRegistered(uint256 indexed jobId, address indexed policy, address indexed client);
    /// @notice Emitted when a verdict is applied. `reason` is the raw value returned by the
    ///         policy; the kernel's JobCompleted/JobRejected events carry
    ///         `keccak256(abi.encode(policy, reason))` so each kernel reason is uniquely
    ///         namespaced to the policy that produced it.
    event JobSettled(uint256 indexed jobId, address indexed policy, uint8 indexed verdict, bytes32 reason);
    /// @notice Emitted when a routed job's terminal status is reflected back
    ///         into Router-side bookkeeping (audit L03). `status` is the
    ///         kernel status read at finalisation time:
    ///           - `Completed` / `Rejected`: synthetic; afterAction-driven.
    ///           - `Expired`: explicit, via {markExpired} after `claimRefund`.
    event JobFinalised(uint256 indexed jobId, IACP.JobStatus indexed status);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error ZeroAddress();
    error NotCommerce();
    error NotJobClient();
    error JobNotOpen();
    error RouterNotEvaluator();
    error RouterNotHook();
    error PolicyNotWhitelisted();
    error PolicyAlreadySet();
    error PolicyNotSet();
    error NotDecided();
    error NotPaused();
    error UnknownVerdict(uint8 verdict);
    /// @notice Thrown by {setCommerce} when {jobInflightCount} is non-zero;
    ///         repointing the Router at a new kernel before all in-flight
    ///         jobs are drained would orphan their escrow on the old one
    ///         (audit L03).
    error HasInflightJobs();
    /// @notice Thrown by {markExpired} when the underlying job has not yet
    ///         transitioned to the kernel's `Expired` status. {afterAction}
    ///         already handles `Completed` / `Rejected`, so {markExpired} is
    ///         exclusively the `claimRefund` reconciliation path.
    error NotExpired();

    // ---------------------------------------------------------------
    // Initialisation
    // ---------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialiser invoked via proxy. `commerce_` is the ERC-8183
    ///         kernel this Router targets.
    function initialize(address commerce_, address owner_) external initializer {
        if (commerce_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Pausable_init();
        __UUPSUpgradeable_init();

        _router().commerce = IACP(commerce_);
        emit CommerceSet(address(0), commerce_);
    }

    // ---------------------------------------------------------------
    // UUPS
    // ---------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Toggle whether a policy contract is allowed to serve new jobs.
    function setPolicyWhitelist(address policy, bool status) external onlyOwner {
        if (policy == address(0)) revert ZeroAddress();
        _router().policyWhitelist[policy] = status;
        emit PolicyWhitelisted(policy, status);
    }

    /// @notice Point the Router at a different ERC-8183 kernel.
    /// @dev    Only allowed while paused AND while no jobs remain in flight
    ///         (audit L03). The drain SOP is:
    ///           1. `pause()` to block new {registerJob} / {settle}.
    ///           2. Let in-flight jobs reach a terminal status:
    ///              - `complete` / `reject` decrements `jobInflightCount`
    ///                automatically via {afterAction}.
    ///              - For jobs that exit via the non-hookable `claimRefund`
    ///                path on the kernel (status → `Expired`), anyone calls
    ///                {markExpired} to reconcile Router-side state.
    ///           3. Once `inflightJobCount() == 0`, `setCommerce` succeeds.
    ///         See `docs/design.md` §6 R6 "Router drain SOP".
    function setCommerce(address newCommerce) external onlyOwner {
        if (newCommerce == address(0)) revert ZeroAddress();
        if (!paused()) revert NotPaused();
        RouterStorage storage $ = _router();
        if ($.jobInflightCount != 0) revert HasInflightJobs();
        address old = address($.commerce);
        $.commerce = IACP(newCommerce);
        emit CommerceSet(old, newCommerce);
    }

    /// @notice Emergency brake. Blocks {registerJob} and {settle} so admin has
    ///         time to investigate a Router bug and ship a UUPS upgrade before
    ///         any further verdicts are applied to the kernel.
    /// @dev    Does NOT guard {beforeAction} / {afterAction}: those are invoked
    ///         synchronously by the kernel on every mutating call, and pausing
    ///         them would cascade reverts into unrelated kernel flows. The
    ///         universal escape hatch for clients is still `commerce.claimRefund`,
    ///         which is never pausable nor hookable.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function commerce() external view returns (address) {
        return address(_router().commerce);
    }

    function jobPolicy(uint256 jobId) external view returns (address) {
        return _router().jobPolicy[jobId];
    }

    function policyWhitelist(address policy) external view returns (bool) {
        return _router().policyWhitelist[policy];
    }

    /// @notice Number of routed jobs whose terminal status has not yet been
    ///         reflected into Router-side bookkeeping (audit L03).
    function inflightJobCount() external view returns (uint256) {
        return _router().jobInflightCount;
    }

    // ---------------------------------------------------------------
    // Client-facing: register a job with a policy
    // ---------------------------------------------------------------

    /// @notice Bind `policy` to `jobId`. Callable only by the job's client.
    /// @dev    Preconditions:
    ///           - Job status == Open.
    ///           - `job.evaluator == address(this)`.
    ///           - `job.hook      == address(this)`.
    ///           - `policy` is whitelisted.
    ///           - Policy has not been set for this job.
    ///         `nonReentrant` is defence-in-depth (audit I06): today the only
    ///         external call is `commerce.getJob(...)` (a view), so a re-entry
    ///         is impossible. The guard locks in the CEI ordering so a future
    ///         policy upgrade that needs to perform an external write here
    ///         cannot accidentally regress the property.
    function registerJob(uint256 jobId, address policy) external nonReentrant whenNotPaused {
        RouterStorage storage $ = _router();
        if (!$.policyWhitelist[policy]) revert PolicyNotWhitelisted();
        if ($.jobPolicy[jobId] != address(0)) revert PolicyAlreadySet();

        IACP.Job memory job = $.commerce.getJob(jobId);
        if (job.id == 0 || job.status != IACP.JobStatus.Open) revert JobNotOpen();
        if (msg.sender != job.client) revert NotJobClient();
        if (job.evaluator != address(this)) revert RouterNotEvaluator();
        if (job.hook != address(this)) revert RouterNotHook();

        $.jobPolicy[jobId] = policy;
        unchecked {
            ++$.jobInflightCount;
        }
        emit JobRegistered(jobId, policy, msg.sender);
    }

    /// @notice Reconcile a `claimRefund`-driven exit (kernel status =
    ///         `Expired`) into Router-side bookkeeping.
    /// @dev    Permissionless. Required because `claimRefund` MUST NOT be
    ///         hookable per ERC-8183 (and because the kernel guarantees that
    ///         escape hatch is non-revertible), so {afterAction} cannot
    ///         observe it. {markExpired} closes the resulting accounting gap
    ///         so {setCommerce}'s `jobInflightCount == 0` requirement is
    ///         actually reachable (audit L03).
    function markExpired(uint256 jobId) external nonReentrant {
        RouterStorage storage $ = _router();
        if ($.jobPolicy[jobId] == address(0)) revert PolicyNotSet();
        IACP.Job memory job = $.commerce.getJob(jobId);
        if (job.status != IACP.JobStatus.Expired) revert NotExpired();

        delete $.jobPolicy[jobId];
        unchecked {
            --$.jobInflightCount;
        }
        emit JobFinalised(jobId, IACP.JobStatus.Expired);
    }

    // ---------------------------------------------------------------
    // Permissionless: settle a job by pulling the policy verdict
    // ---------------------------------------------------------------

    /// @notice Pull the current verdict from the job's policy and apply it
    ///         to the kernel. Permissionless.
    /// @param  jobId     Kernel job id.
    /// @param  evidence  Forwarded verbatim to `policy.check`.
    function settle(uint256 jobId, bytes calldata evidence) external nonReentrant whenNotPaused {
        RouterStorage storage $ = _router();
        address policy = $.jobPolicy[jobId];
        if (policy == address(0)) revert PolicyNotSet();

        (uint8 verdict, bytes32 reason) = IPolicy(policy).check(jobId, evidence);

        // Namespace the reason with the policy address so the kernel's
        // JobCompleted/JobRejected events carry a value that is both unique to
        // this policy and verifiable against this Router's JobSettled event.
        bytes32 wrappedReason = keccak256(abi.encode(policy, reason));

        if (verdict == VERDICT_APPROVE) {
            $.commerce.complete(jobId, wrappedReason, "");
        } else if (verdict == VERDICT_REJECT) {
            $.commerce.reject(jobId, wrappedReason, "");
        } else if (verdict == VERDICT_PENDING) {
            revert NotDecided();
        } else {
            revert UnknownVerdict(verdict);
        }

        emit JobSettled(jobId, policy, verdict, reason);
    }

    // ---------------------------------------------------------------
    // IACPHook
    // ---------------------------------------------------------------

    /// @notice ERC-8183 hook invoked before every mutating kernel action.
    /// @dev    NOT `nonReentrant`: the Router sits on the reentrant path
    ///         `settle → commerce.complete → router.afterAction`, and guarding
    ///         this function would deadlock. Access control relies on
    ///         `msg.sender == commerce`.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata /* data */) external view override {
        RouterStorage storage $ = _router();
        if (msg.sender != address($.commerce)) revert NotCommerce();

        if (selector == FUND_SELECTOR) {
            if ($.jobPolicy[jobId] == address(0)) revert PolicyNotSet();
        }
    }

    /// @notice ERC-8183 hook invoked after every mutating kernel action.
    /// @dev    On `SUBMIT` the Router forwards a one-shot notification to the
    ///         registered policy so time-sensitive state can be initialised.
    ///         Both the 32-byte `deliverable` and the provider's opaque
    ///         `optParams` are transported unchanged so policies can bind
    ///         extra commitments (URI, manifest hash, ZK public inputs, ...)
    ///         without requiring a Router upgrade.
    ///
    ///         On `COMPLETE` / `REJECT` the Router also reconciles its
    ///         {jobInflightCount} so {setCommerce} can be unlocked once every
    ///         routed job has reached a terminal state (audit L03). The guard
    ///         `jobPolicy[jobId] != 0` prevents double-decrement and absorbs
    ///         the legitimate corner case of an Open-state `reject` on a
    ///         routed job that never made it past {registerJob}.
    ///
    ///         NOT `nonReentrant` (see {beforeAction}).
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external override {
        RouterStorage storage $ = _router();
        if (msg.sender != address($.commerce)) revert NotCommerce();

        if (selector == SUBMIT_SELECTOR) {
            address policy = $.jobPolicy[jobId];
            if (policy == address(0)) revert PolicyNotSet();
            (bytes32 deliverable, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
            IPolicy(policy).onSubmitted(jobId, deliverable, optParams);
        } else if (selector == COMPLETE_SELECTOR || selector == REJECT_SELECTOR) {
            if ($.jobPolicy[jobId] != address(0)) {
                delete $.jobPolicy[jobId];
                unchecked {
                    --$.jobInflightCount;
                }
                emit JobFinalised(
                    jobId,
                    selector == COMPLETE_SELECTOR ? IACP.JobStatus.Completed : IACP.JobStatus.Rejected
                );
            }
        }
    }

    // ---------------------------------------------------------------
    // ERC-165
    // ---------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
