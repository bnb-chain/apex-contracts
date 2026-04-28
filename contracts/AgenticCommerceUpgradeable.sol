// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IACP} from "./IACP.sol";
import {IACPHook} from "./IACPHook.sol";

/// @title AgenticCommerceUpgradeable (v1)
/// @notice Lightweight ERC-8183 Agentic Commerce Protocol kernel.
/// @dev    UUPS upgradeable. Keeps the full ERC-8183 `MUST`/`SHOULD` surface
///         and drops non-spec features (meta-transactions, permit, role-based
///         access, hook whitelist, evaluator fee).
///
///         Upgrade governance SHOULD be a multisig + TimelockController.
contract AgenticCommerceUpgradeable is
    IACP,
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice Gas ceiling applied to every hook call per ERC-8183 SHOULD.
    uint256 public constant HOOK_GAS_LIMIT = 1_000_000;

    /// @notice Basis-point denominator. `feeBP = 10_000` = 100%.
    uint256 public constant BP_DENOMINATOR = 10_000;

    /// @notice Maximum lifetime of a job from creation to {claimRefund}
    ///         eligibility. Prevents `expiredAt` from being set so far in the
    ///         future that the kernel's permissionless refund path is
    ///         effectively unreachable, locking escrow forever (audit L01).
    uint256 public constant MAX_EXPIRY_DURATION = 365 days;

    // ---------------------------------------------------------------
    // Storage (flat upgradeable layout; append-only)
    // ---------------------------------------------------------------

    /// @notice ERC-20 escrow / settlement token. Set once in {initialize}.
    /// @dev    Stored as `address` so the auto-generated public getter
    ///         matches `IACP.paymentToken()` exactly.
    address public paymentToken;

    /// @notice Platform fee in basis points (0..10_000).
    uint256 public platformFeeBP;

    /// @notice Recipient of the platform fee.
    address public platformTreasury;

    /// @notice Monotonically increasing job id counter.
    uint256 public jobCounter;

    /// @notice Per-job state, keyed by job id.
    /// @dev    Exposed as `public` so clients / indexers and the Router/Policy
    ///         layer can read tuples directly without a helper call.
    mapping(uint256 jobId => Job job) public jobs;

    /// @notice Whether `setBudget` has been called at least once for `jobId`.
    ///         Required because `budget == 0` is a legal state before setup.
    mapping(uint256 jobId => bool hasBudget) public jobHasBudget;

    /// @dev Reserved storage slots for future upgrades.
    uint256[44] private __gap;

    // ---------------------------------------------------------------
    // Events (ERC-8183 standard set; no ReputationSignal)
    // ---------------------------------------------------------------

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    /// @notice Emitted on successful escrow.
    /// @dev    `provider` is `indexed` so providers can `eth_getLogs` for jobs
    ///         assigned to them without joining against {JobCreated} (audit I03).
    ///         The Router-mediated client flow always sets `provider` before
    ///         `fund`, so it is observably the locked-in counterparty at this
    ///         moment. This adds one topic to the spec-canonical
    ///         `JobFunded(jobId, client, amount)` shape; see
    ///         `docs/erc-8183-compliance.md` for the disclosed deviation.
    event JobFunded(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event PlatformFeeUpdated(uint256 feeBP, address indexed treasury);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error ZeroAddress();
    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    /// @notice Thrown by {setProvider} when the job already has a provider
    ///         bound to it. Distinguishes the "provider already set" branch
    ///         from generic status mismatches so off-chain clients can
    ///         surface a precise error to users (audit I05).
    error ProviderAlreadySet();
    error ExpiryTooShort();
    /// @notice Thrown by {createJob} when `expiredAt` is further in the future
    ///         than {MAX_EXPIRY_DURATION} (audit L01).
    error ExpiryTooLong();
    error ZeroBudget();
    error BudgetMismatch();
    error ProviderNotSet();
    error FeeTooHigh();
    error HookMissingInterface();
    error HookCallFailed();
    /// @notice Thrown by {createJob} when `hook == address(0)`. Every job MUST
    ///         have a hook contract — the zero address bypasses
    ///         `_beforeHook` / `_afterHook` and would silently disable any
    ///         hook-enforced policy gating (audit L05). The runtime
    ///         `hook == 0` skip in `_beforeHook` / `_afterHook` is retained
    ///         as defence-in-depth even though no new job can reach it.
    error HookRequired();

    // ---------------------------------------------------------------
    // Initialisation
    // ---------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initialiser run through the proxy.
    /// @param paymentToken_ ERC-20 escrow token (immutable after this call).
    /// @param treasury_     Platform fee recipient.
    /// @param owner_        Initial owner (RECOMMENDED multisig).
    function initialize(address paymentToken_, address treasury_, address owner_) external initializer {
        if (paymentToken_ == address(0) || treasury_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        __Ownable_init(owner_);
        __Pausable_init();
        __UUPSUpgradeable_init();

        paymentToken = paymentToken_;
        platformTreasury = treasury_;
    }

    // ---------------------------------------------------------------
    // UUPS
    // ---------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Update the platform fee and treasury address.
    /// @param  feeBP_     New fee in basis points. Maximum 10_000 (100%).
    /// @param  treasury_  New fee recipient.
    function setPlatformFee(uint256 feeBP_, address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBP_ > BP_DENOMINATOR) revert FeeTooHigh();
        platformFeeBP = feeBP_;
        platformTreasury = treasury_;
        emit PlatformFeeUpdated(feeBP_, treasury_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------
    // Hook dispatch (gas-limited per ERC-8183 SHOULD)
    // ---------------------------------------------------------------

    function _beforeHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        // ERC-8183 SHOULD: hook dispatch must be gas-limited so a malicious hook
        // cannot grief the kernel. Only low-level `.call` exposes `{gas: ...}`.
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(
            abi.encodeCall(IACPHook.beforeAction, (jobId, selector, data))
        );
        if (!success) {
            _bubble(returnData);
        }
    }

    function _afterHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        // ERC-8183 SHOULD: hook dispatch must be gas-limited (see {_beforeHook}).
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(
            abi.encodeCall(IACPHook.afterAction, (jobId, selector, data))
        );
        if (!success) {
            _bubble(returnData);
        }
    }

    function _bubble(bytes memory returnData) private pure {
        if (returnData.length > 0) {
            // Re-raise the hook's original revert reason verbatim. Only assembly
            // can `revert(dataPtr, dataLen)` with a pre-encoded byte string.
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        revert HookCallFailed();
    }

    // ---------------------------------------------------------------
    // ERC-8183 core
    // ---------------------------------------------------------------

    /// @notice Create a new job in the `Open` state.
    /// @param  provider     Provider address. MAY be `address(0)` (set later
    ///                      via {setProvider}).
    /// @param  evaluator    Evaluator address. MUST NOT be zero.
    /// @param  expiredAt    Unix timestamp at which the job becomes refundable.
    ///                      MUST be at least 5 minutes in the future and at
    ///                      most {MAX_EXPIRY_DURATION} away (audit L01).
    /// @param  description  Human-readable description.
    /// @param  hook         Hook contract address. MUST be non-zero and MUST
    ///                      implement {IACPHook} per ERC-165 (audit L05).
    ///                      Use a no-op `IACPHook` when an evaluator does not
    ///                      need pre/post-action callbacks.
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp + 5 minutes) revert ExpiryTooShort();
        if (expiredAt > block.timestamp + MAX_EXPIRY_DURATION) revert ExpiryTooLong();
        if (hook == address(0)) revert HookRequired();
        if (!ERC165Checker.supportsInterface(hook, type(IACPHook).interfaceId)) {
            revert HookMissingInterface();
        }

        unchecked {
            jobId = ++jobCounter;
        }
        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: hook,
            submittedAt: 0
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);

        _afterHook(hook, jobId, this.createJob.selector, abi.encode(msg.sender, provider, evaluator));
    }

    /// @notice Client sets the provider after creation (only allowed while Open
    ///         and while provider is unset).
    function setProvider(
        uint256 jobId,
        address provider_,
        bytes calldata optParams
    ) external nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert ProviderAlreadySet();
        if (provider_ == address(0)) revert ZeroAddress();

        bytes memory hookData = abi.encode(provider_, optParams);
        _beforeHook(job.hook, jobId, this.setProvider.selector, hookData);
        job.provider = provider_;
        _afterHook(job.hook, jobId, this.setProvider.selector, hookData);

        emit ProviderSet(jobId, provider_);
    }

    /// @notice Set the budget for a job. Per ERC-8183, either `client` or
    ///         `provider` MAY call this. Front-running on {fund} is prevented
    ///         by the `expectedBudget` parameter.
    /// @dev    `amount == 0` is rejected up front (audit I02). The kernel
    ///         treats `budget > 0` as an invariant of the `Funded` state, and
    ///         {fund} would otherwise need to encode that invariant a second
    ///         time. Rejecting at the source also lets us simplify {fund}
    ///         to a single `jobHasBudget` check.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client && msg.sender != job.provider) {
            revert Unauthorized();
        }
        if (amount == 0) revert ZeroBudget();

        bytes memory hookData = abi.encode(amount, optParams);
        _beforeHook(job.hook, jobId, this.setBudget.selector, hookData);
        job.budget = amount;
        jobHasBudget[jobId] = true;
        _afterHook(job.hook, jobId, this.setBudget.selector, hookData);

        emit BudgetSet(jobId, amount);
    }

    /// @notice Client deposits escrow equal to `expectedBudget`. Reverts if
    ///         `job.budget != expectedBudget` (front-running guard).
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (!jobHasBudget[jobId]) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();

        _beforeHook(job.hook, jobId, this.fund.selector, optParams);
        job.status = JobStatus.Funded;
        IERC20(paymentToken).safeTransferFrom(job.client, address(this), job.budget);
        _afterHook(job.hook, jobId, this.fund.selector, optParams);

        emit JobFunded(jobId, job.client, job.provider, job.budget);
    }

    /// @notice Provider submits the deliverable hash, moving the job to the
    ///         `Submitted` state.
    /// @dev    Reverts with `WrongStatus` if `block.timestamp >= expiredAt`,
    ///         mirroring the existing guard in {fund}. Submitting after
    ///         expiry would let the client (or any observer) front-run the
    ///         provider via {claimRefund} and walk away with both the
    ///         deliverable and the escrow (audit L02).
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();

        bytes memory hookData = abi.encode(deliverable, optParams);
        _beforeHook(job.hook, jobId, this.submit.selector, hookData);
        job.status = JobStatus.Submitted;
        job.submittedAt = block.timestamp;
        _afterHook(job.hook, jobId, this.submit.selector, hookData);

        emit JobSubmitted(jobId, job.provider, deliverable);
    }

    /// @notice Evaluator approves a submitted job, releasing payment minus
    ///         the platform fee.
    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();

        bytes memory hookData = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, this.complete.selector, hookData);
        job.status = JobStatus.Completed;

        uint256 amount = job.budget;
        uint256 platformFee = (amount * platformFeeBP) / BP_DENOMINATOR;
        uint256 net = amount - platformFee;

        if (platformFee > 0) {
            IERC20(paymentToken).safeTransfer(platformTreasury, platformFee);
        }
        if (net > 0) {
            IERC20(paymentToken).safeTransfer(job.provider, net);
        }

        _afterHook(job.hook, jobId, this.complete.selector, hookData);

        emit JobCompleted(jobId, job.evaluator, reason);
        emit PaymentReleased(jobId, job.provider, net);
    }

    /// @notice Reject a job.
    /// @dev    - Open   : client-only (cancel before escrow).
    ///         - Funded : evaluator-only (refund client).
    ///         - Submitted : evaluator-only (refund client).
    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();

        JobStatus prev = job.status;
        if (prev == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (prev == JobStatus.Funded || prev == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        bytes memory hookData = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, this.reject.selector, hookData);
        job.status = JobStatus.Rejected;

        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && job.budget > 0) {
            IERC20(paymentToken).safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        _afterHook(job.hook, jobId, this.reject.selector, hookData);

        emit JobRejected(jobId, msg.sender, reason);
    }

    /// @notice Permissionless refund path after `expiredAt`.
    /// @dev    - NOT `whenNotPaused` (guaranteed recovery path).
    ///         - Hooks are NOT invoked on this path.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) {
            revert WrongStatus();
        }
        if (block.timestamp < job.expiredAt) revert WrongStatus();

        job.status = JobStatus.Expired;
        if (job.budget > 0) {
            IERC20(paymentToken).safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobExpired(jobId);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @inheritdoc IACP
    function getJob(uint256 jobId) external view override returns (Job memory) {
        return jobs[jobId];
    }
}
