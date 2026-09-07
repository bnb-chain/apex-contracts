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

import {IACPHook} from "../IACPHook.sol";

/// @dev Frozen copy of the pre-multi-token IACP surface. Keeping this local
///      prevents the legacy implementation from inheriting today's extended
///      interface and accidentally gaining jobPaymentToken before the upgrade.
interface IACP {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
        uint256 submittedAt;
        bytes32 deliverable;
    }

    function getJob(uint256 jobId) external view returns (Job memory);

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    function paymentToken() external view returns (address);
}

/// @dev Test-only implementation frozen at the flat storage layout immediately
///      before multi-token support. It intentionally does not inherit the
///      current AgenticCommerceUpgradeable implementation.
contract AgenticCommerceLegacyMock is
    IACP,
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    uint256 public constant HOOK_GAS_LIMIT = 1_000_000;
    uint256 public constant BP_DENOMINATOR = 10_000;
    uint256 public constant MAX_PLATFORM_FEE_BP = 1_000;
    uint256 public constant MAX_EXPIRY_DURATION = 365 days;

    // Keep these declarations exactly aligned with the legacy flat storage
    // layout. New implementations may only append by shrinking this gap.
    address public paymentToken;
    uint256 public platformFeeBP;
    address public platformTreasury;
    uint256 public jobCounter;
    mapping(uint256 jobId => Job job) public jobs;
    mapping(uint256 jobId => bool hasBudget) public jobHasBudget;
    uint256[44] private __gap;

    error ZeroAddress();
    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ExpiryTooShort();
    error ExpiryTooLong();
    error ZeroBudget();
    error BudgetMismatch();
    error ProviderNotSet();
    error FeeTooHigh();
    error HookMissingInterface();
    error HookCallFailed();
    error HookRequired();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setPlatformFee(uint256 feeBP_, address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBP_ > MAX_PLATFORM_FEE_BP) revert FeeTooHigh();
        platformFeeBP = feeBP_;
        platformTreasury = treasury_;
    }

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
            submittedAt: 0,
            deliverable: bytes32(0)
        });
        _afterHook(hook, jobId, this.createJob.selector, abi.encode(msg.sender, provider, evaluator));
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();

        bytes memory hookData = abi.encode(amount, optParams);
        _beforeHook(job.hook, jobId, this.setBudget.selector, hookData);
        job.budget = amount;
        jobHasBudget[jobId] = true;
        _afterHook(job.hook, jobId, this.setBudget.selector, hookData);
    }

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
        if (job.budget > 0) {
            IERC20(paymentToken).safeTransferFrom(job.client, address(this), job.budget);
        }
        _afterHook(job.hook, jobId, this.fund.selector, optParams);
    }

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
        job.deliverable = deliverable;
        _afterHook(job.hook, jobId, this.submit.selector, hookData);
    }

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
        if (platformFee > 0) IERC20(paymentToken).safeTransfer(platformTreasury, platformFee);
        if (net > 0) IERC20(paymentToken).safeTransfer(job.provider, net);

        _afterHook(job.hook, jobId, this.complete.selector, hookData);
    }

    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();

        JobStatus previousStatus = job.status;
        if (previousStatus == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (previousStatus == JobStatus.Funded || previousStatus == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        bytes memory hookData = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, this.reject.selector, hookData);
        job.status = JobStatus.Rejected;
        if ((previousStatus == JobStatus.Funded || previousStatus == JobStatus.Submitted) && job.budget > 0) {
            IERC20(paymentToken).safeTransfer(job.client, job.budget);
        }
        _afterHook(job.hook, jobId, this.reject.selector, hookData);
    }

    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert WrongStatus();

        job.status = JobStatus.Expired;
        if (job.budget > 0) IERC20(paymentToken).safeTransfer(job.client, job.budget);
    }

    function getJob(uint256 jobId) external view override returns (Job memory) {
        return jobs[jobId];
    }

    function _beforeHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) private {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(
            abi.encodeCall(IACPHook.beforeAction, (jobId, selector, data))
        );
        if (!success) _bubble(returnData);
    }

    function _afterHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) private {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(
            abi.encodeCall(IACPHook.afterAction, (jobId, selector, data))
        );
        if (!success) _bubble(returnData);
    }

    function _bubble(bytes memory returnData) private pure {
        if (returnData.length > 0) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        revert HookCallFailed();
    }
}
