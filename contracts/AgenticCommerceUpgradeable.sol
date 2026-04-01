// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import "./IACPHook.sol";

contract AgenticCommerceUpgradeable is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardTransient,
    PausableUpgradeable,
    ERC2771Context,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint256 public constant HOOK_GAS_LIMIT = 1_000_000;

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
    }

    IERC20 public paymentToken;
    uint256 public platformFeeBP;
    address public platformTreasury;
    uint256 public evaluatorFeeBP;

    mapping(uint256 => Job) public jobs;
    uint256 public jobCounter;
    mapping(address => bool) public whitelistedHooks;
    mapping(uint256 jobId => bool hasBudget) public jobHasBudget;

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed provider,
        address evaluator, uint256 expiredAt, address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event HookWhitelistUpdated(address indexed hook, bool status);
    event ReputationSignal(uint256 indexed jobId, address indexed subject, string role, int8 signal);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error ExpiryTooShort();
    error ZeroBudget();
    error ProviderNotSet();
    error FeesTooHigh();
    error HookNotWhitelisted();
    error BudgetMismatch();
    error HookCallFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address trustedForwarder_) ERC2771Context(trustedForwarder_) {
        _disableInitializers();
    }

    function initialize(address paymentToken_, address treasury_, address admin_) public initializer {
        if (paymentToken_ == address(0) || treasury_ == address(0) || admin_ == address(0))
            revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();
        paymentToken = IERC20(paymentToken_);
        platformTreasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        whitelistedHooks[address(0)] = true;
    }

    // ============================================================
    //  ERC-2771 Overrides
    // ============================================================

    function _msgSender() internal view override(ContextUpgradeable, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(ContextUpgradeable, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(ContextUpgradeable, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }

    // ============================================================
    //  UUPS
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ============================================================
    //  Admin Functions
    // ============================================================

    function setPlatformFee(uint256 feeBP_, address treasury_) external onlyRole(ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBP_ + evaluatorFeeBP > 10000) revert FeesTooHigh();
        platformFeeBP = feeBP_;
        platformTreasury = treasury_;
    }

    function setEvaluatorFee(uint256 feeBP_) external onlyRole(ADMIN_ROLE) {
        if (feeBP_ + platformFeeBP > 10000) revert FeesTooHigh();
        evaluatorFeeBP = feeBP_;
    }

    function setHookWhitelist(address hook, bool status) external onlyRole(ADMIN_ROLE) {
        if (hook == address(0)) revert ZeroAddress();
        whitelistedHooks[hook] = status;
        emit HookWhitelistUpdated(hook, status);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    //  Hook Execution (gas-limited per SHOULD)
    // ============================================================

    function _beforeHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(
            abi.encodeCall(IACPHook.beforeAction, (jobId, selector, data))
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly { revert(add(returnData, 32), mload(returnData)) }
            }
            revert HookCallFailed();
        }
    }

    function _afterHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(
            abi.encodeCall(IACPHook.afterAction, (jobId, selector, data))
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly { revert(add(returnData, 32), mload(returnData)) }
            }
            revert HookCallFailed();
        }
    }

    // ============================================================
    //  Core Functions
    // ============================================================

    function createJob(
        address provider, address evaluator, uint256 expiredAt,
        string calldata description, address hook
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp + 5 minutes) revert ExpiryTooShort();
        if (!whitelistedHooks[hook]) revert HookNotWhitelisted();
        if (hook != address(0)) {
            if (!ERC165Checker.supportsInterface(hook, type(IACPHook).interfaceId))
                revert InvalidJob();
        }
        uint256 jobId = ++jobCounter;
        jobs[jobId] = Job({
            id: jobId,
            client: _msgSender(),
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: hook
        });
        emit JobCreated(jobId, _msgSender(), provider, evaluator, expiredAt, hook);
        _afterHook(hook, jobId, this.createJob.selector, abi.encode(_msgSender(), provider, evaluator));
        return jobId;
    }

    function setProvider(uint256 jobId, address provider_, bytes calldata optParams)
        external nonReentrant whenNotPaused
    {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (_msgSender() != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert WrongStatus();
        if (provider_ == address(0)) revert ZeroAddress();

        bytes memory hookData = abi.encode(provider_, optParams);
        _beforeHook(job.hook, jobId, this.setProvider.selector, hookData);
        job.provider = provider_;
        _afterHook(job.hook, jobId, this.setProvider.selector, hookData);

        emit ProviderSet(jobId, provider_);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams)
        external nonReentrant whenNotPaused
    {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (_msgSender() != job.client && _msgSender() != job.provider) revert Unauthorized();

        bytes memory hookData = abi.encode(amount, optParams);
        _beforeHook(job.hook, jobId, this.setBudget.selector, hookData);
        job.budget = amount;
        jobHasBudget[jobId] = true;
        _afterHook(job.hook, jobId, this.setBudget.selector, hookData);

        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams)
        external nonReentrant whenNotPaused
    {
        _fund(jobId, expectedBudget, optParams);
    }

    function fundWithPermit(
        uint256 jobId, uint256 expectedBudget, bytes calldata optParams,
        uint256 deadline, uint8 v, bytes32 r, bytes32 s
    ) external nonReentrant whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        IERC20Permit(address(paymentToken)).permit(
            _msgSender(), address(this), expectedBudget, deadline, v, r, s
        );
        _fund(jobId, expectedBudget, optParams);
    }

    function _fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) internal {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (_msgSender() != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();

        _beforeHook(job.hook, jobId, this.fund.selector, optParams);
        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(job.client, address(this), job.budget);
        _afterHook(job.hook, jobId, this.fund.selector, optParams);

        emit JobFunded(jobId, job.client, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams)
        external nonReentrant whenNotPaused
    {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (_msgSender() != job.provider) revert Unauthorized();

        bytes memory hookData = abi.encode(deliverable, optParams);
        _beforeHook(job.hook, jobId, this.submit.selector, hookData);
        job.status = JobStatus.Submitted;
        _afterHook(job.hook, jobId, this.submit.selector, hookData);

        emit JobSubmitted(jobId, job.provider, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams)
        external nonReentrant whenNotPaused
    {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (_msgSender() != job.evaluator) revert Unauthorized();

        bytes memory hookData = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, this.complete.selector, hookData);
        job.status = JobStatus.Completed;

        uint256 amount = job.budget;
        uint256 platformFee = (amount * platformFeeBP) / 10000;
        uint256 evalFee = (amount * evaluatorFeeBP) / 10000;
        uint256 net = amount - platformFee - evalFee;

        if (platformFee > 0) {
            paymentToken.safeTransfer(platformTreasury, platformFee);
        }
        if (evalFee > 0) {
            paymentToken.safeTransfer(job.evaluator, evalFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evalFee);
        }
        if (net > 0) {
            paymentToken.safeTransfer(job.provider, net);
        }

        _afterHook(job.hook, jobId, this.complete.selector, hookData);

        emit JobCompleted(jobId, job.evaluator, reason);
        emit PaymentReleased(jobId, job.provider, net);
        emit ReputationSignal(jobId, job.provider, "provider", int8(1));
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams)
        external nonReentrant whenNotPaused
    {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();

        if (job.status == JobStatus.Open) {
            if (_msgSender() != job.client) revert Unauthorized();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            if (_msgSender() != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        bytes memory hookData = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, this.reject.selector, hookData);
        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;

        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
            emit ReputationSignal(jobId, job.provider, "provider", int8(-1));
        }

        _afterHook(job.hook, jobId, this.reject.selector, hookData);

        emit JobRejected(jobId, _msgSender(), reason);
    }

    // claimRefund: NOT pausable, NOT hookable (guaranteed recovery path)
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted)
            revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert WrongStatus();

        job.status = JobStatus.Expired;
        if (job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobExpired(jobId);
        emit ReputationSignal(jobId, job.provider, "provider", int8(0));
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
