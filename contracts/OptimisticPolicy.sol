// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IACP} from "./IACP.sol";
import {IPolicy} from "./IPolicy.sol";

/// @title OptimisticPolicy (v1)
/// @notice UMA-style optimistic evaluation policy: silence approves, disputes
///         trigger a whitelisted-voter quorum check.
///
/// @dev    Lifecycle per job:
///         1. Router calls `onSubmitted(jobId, deliverable)` once, right after
///            the kernel's `submit`. `submittedAt` is recorded.
///         2. Client MAY call `dispute(jobId)` within `disputeWindow`.
///         3. Whitelisted voters MAY call `voteReject(jobId)` once each.
///         4. `check(jobId, _)` returns:
///              - APPROVE  if not disputed AND `submittedAt + disputeWindow`
///                has elapsed.
///              - REJECT   if disputed AND `rejectVotes >= voteQuorum`.
///              - PENDING  otherwise.
///
///         Verdicts: 0 = Pending, 1 = Approve, 2 = Reject.
contract OptimisticPolicy is IPolicy {
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    uint8 internal constant VERDICT_PENDING = 0;
    uint8 internal constant VERDICT_APPROVE = 1;
    uint8 internal constant VERDICT_REJECT = 2;

    /// @notice Reason code emitted when the optimistic window elapses with
    ///         no dispute (default-approve).
    bytes32 public constant REASON_APPROVED = keccak256("OPTIMISTIC_APPROVED");

    /// @notice Reason code emitted when voters reach `voteQuorum` for reject.
    bytes32 public constant REASON_REJECTED = keccak256("OPTIMISTIC_REJECTED");

    // ---------------------------------------------------------------
    // Immutable config
    // ---------------------------------------------------------------

    /// @notice ERC-8183 kernel this policy operates against. Read-only.
    IACP public immutable commerce;

    /// @notice Authorised caller of {onSubmitted} and {check}.
    address public immutable router;

    /// @notice Grace period in seconds after `submit` during which the client
    ///         can dispute. Outside this window, silence auto-approves.
    uint64 public immutable disputeWindow;

    // ---------------------------------------------------------------
    // Mutable config
    // ---------------------------------------------------------------

    /// @notice Minimum number of reject votes required to reach a REJECT
    ///         verdict once a job has been disputed.
    uint16 public voteQuorum;

    /// @notice Total number of currently whitelisted voters. Used to enforce
    ///         `voteQuorum <= activeVoterCount` on admin updates.
    uint16 public activeVoterCount;

    /// @notice Current admin (policy operator). Controls voter list / quorum.
    address public admin;

    /// @notice Pending admin for the two-step transfer flow.
    address public pendingAdmin;

    // ---------------------------------------------------------------
    // Voter whitelist
    // ---------------------------------------------------------------

    mapping(address voter => bool) public isVoter;

    // ---------------------------------------------------------------
    // Per-job state
    // ---------------------------------------------------------------

    mapping(uint256 jobId => uint64) public submittedAt;
    mapping(uint256 jobId => bool) public disputed;
    mapping(uint256 jobId => uint16) public rejectVotes;
    mapping(uint256 jobId => mapping(address voter => bool)) public hasVoted;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event JobInitialised(uint256 indexed jobId, bytes32 deliverable, uint64 submittedAt);
    event Disputed(uint256 indexed jobId, address indexed client);
    event VoteCast(uint256 indexed jobId, address indexed voter, uint16 rejectVotes);
    event VoterAdded(address indexed voter, uint16 activeVoterCount);
    event VoterRemoved(address indexed voter, uint16 activeVoterCount);
    event QuorumUpdated(uint16 oldQuorum, uint16 newQuorum);
    event AdminTransferStarted(address indexed previousAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error ZeroAddress();
    error NotRouter();
    error NotAdmin();
    error NotClient();
    error NotVoter();
    error NotPendingAdmin();
    error AlreadyInitialised();
    error AlreadyVoted();
    error AlreadyDisputed();
    error NotSubmitted();
    error NotDisputed();
    error WrongJobStatus();
    error OutsideDisputeWindow();
    error QuorumOutOfRange();
    error QuorumZero();
    error VoterAlreadyExists();
    error UnknownVoter();
    error WouldBreakQuorum();

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ---------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------

    /// @param commerce_       ERC-8183 kernel address.
    /// @param router_         Evaluator router authorised to call
    ///                        {onSubmitted} / {check}.
    /// @param admin_          Initial admin (RECOMMENDED multisig).
    /// @param disputeWindow_  Dispute grace window in seconds.
    /// @param initialQuorum_  Initial `voteQuorum` (MUST be `>= 1`). Caller
    ///                        MUST add `>= initialQuorum_` voters before any
    ///                        disputed job can settle.
    constructor(address commerce_, address router_, address admin_, uint64 disputeWindow_, uint16 initialQuorum_) {
        if (commerce_ == address(0) || router_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        if (initialQuorum_ == 0) revert QuorumZero();

        commerce = IACP(commerce_);
        router = router_;
        disputeWindow = disputeWindow_;
        admin = admin_;
        voteQuorum = initialQuorum_;

        emit AdminTransferred(address(0), admin_);
        emit QuorumUpdated(0, initialQuorum_);
    }

    // ---------------------------------------------------------------
    // IPolicy
    // ---------------------------------------------------------------

    /// @inheritdoc IPolicy
    function onSubmitted(uint256 jobId, bytes32 deliverable) external override onlyRouter {
        if (submittedAt[jobId] != 0) revert AlreadyInitialised();
        uint64 ts = uint64(block.timestamp);
        submittedAt[jobId] = ts;
        emit JobInitialised(jobId, deliverable, ts);
    }

    /// @inheritdoc IPolicy
    /// @dev Dispute window is `[submittedAt, submittedAt + disputeWindow)`.
    ///      At exactly `submittedAt + disputeWindow` this function flips to
    ///      APPROVE while {dispute} starts reverting `OutsideDisputeWindow` —
    ///      the boundary moment is treated as "already approved".
    function check(
        uint256 jobId,
        bytes calldata /* evidence */
    ) external view override returns (uint8 verdict, bytes32 reason) {
        uint64 ts = submittedAt[jobId];
        if (ts == 0) {
            return (VERDICT_PENDING, bytes32(0));
        }

        if (disputed[jobId]) {
            if (rejectVotes[jobId] >= voteQuorum) {
                return (VERDICT_REJECT, REASON_REJECTED);
            }
            return (VERDICT_PENDING, bytes32(0));
        }

        if (block.timestamp >= uint256(ts) + uint256(disputeWindow)) {
            return (VERDICT_APPROVE, REASON_APPROVED);
        }
        return (VERDICT_PENDING, bytes32(0));
    }

    // ---------------------------------------------------------------
    // Client / voter actions
    // ---------------------------------------------------------------

    /// @notice Client raises a dispute. MUST be called within `disputeWindow`
    ///         after submission. Flips the job into the "requires quorum"
    ///         path and keeps it PENDING until votes accrue.
    /// @dev    Window is a half-open interval `[submittedAt, submittedAt +
    ///         disputeWindow)`: at exactly `submittedAt + disputeWindow` this
    ///         call reverts and {check} already returns APPROVE. Also reverts
    ///         once the kernel job has left the `Submitted` state — disputing
    ///         a Completed / Rejected job is a no-op that wastes gas, so it
    ///         is rejected up front.
    function dispute(uint256 jobId) external {
        IACP.Job memory job = commerce.getJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        if (job.status != IACP.JobStatus.Submitted) revert WrongJobStatus();

        uint64 ts = submittedAt[jobId];
        // Defensive: under the current kernel, `status == Submitted` implies
        // `submittedAt != 0` via {onSubmitted}. The check is retained so an
        // integration bug in the kernel cannot silently skip the window gate.
        if (ts == 0) revert NotSubmitted();
        if (disputed[jobId]) revert AlreadyDisputed();
        if (block.timestamp >= uint256(ts) + uint256(disputeWindow)) {
            revert OutsideDisputeWindow();
        }

        disputed[jobId] = true;
        emit Disputed(jobId, msg.sender);
    }

    /// @notice Cast a reject vote for a disputed job. Each voter may vote
    ///         at most once per job.
    function voteReject(uint256 jobId) external {
        if (!isVoter[msg.sender]) revert NotVoter();
        if (!disputed[jobId]) revert NotDisputed();
        if (hasVoted[jobId][msg.sender]) revert AlreadyVoted();

        hasVoted[jobId][msg.sender] = true;
        // `rejectVotes[jobId]` is uint16 (max 65535). `unchecked` is safe
        // because {voteReject} is gated by `hasVoted` (1 vote per voter) and
        // the number of whitelisted voters is bounded by `activeVoterCount`
        // (also uint16). Reaching overflow would require >65k voters — well
        // beyond any realistic whitelist size. If the deployment topology
        // ever grows there, widen both counters to uint32 in the next impl.
        uint16 newCount;
        unchecked {
            newCount = rejectVotes[jobId] + 1;
        }
        rejectVotes[jobId] = newCount;
        emit VoteCast(jobId, msg.sender, newCount);
    }

    // ---------------------------------------------------------------
    // Admin: voters and quorum
    // ---------------------------------------------------------------

    function addVoter(address voter) external onlyAdmin {
        if (voter == address(0)) revert ZeroAddress();
        if (isVoter[voter]) revert VoterAlreadyExists();
        isVoter[voter] = true;
        // `activeVoterCount` is uint16 (max 65535). `unchecked` is safe under
        // realistic voter-set sizes (typically ≪ 100). A future deployment
        // that ever expects >65k voters MUST widen this field (storage-
        // layout change → requires upgrade audit) before removing `unchecked`.
        uint16 newCount;
        unchecked {
            newCount = activeVoterCount + 1;
        }
        activeVoterCount = newCount;
        emit VoterAdded(voter, newCount);
    }

    function removeVoter(address voter) external onlyAdmin {
        if (!isVoter[voter]) revert UnknownVoter();
        uint16 newCount = activeVoterCount - 1;
        if (newCount < voteQuorum) revert WouldBreakQuorum();
        isVoter[voter] = false;
        activeVoterCount = newCount;
        emit VoterRemoved(voter, newCount);
    }

    function setQuorum(uint16 newQuorum) external onlyAdmin {
        if (newQuorum == 0) revert QuorumZero();
        if (newQuorum > activeVoterCount) revert QuorumOutOfRange();
        uint16 old = voteQuorum;
        voteQuorum = newQuorum;
        emit QuorumUpdated(old, newQuorum);
    }

    // ---------------------------------------------------------------
    // Admin: two-step transfer
    // ---------------------------------------------------------------

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }
}
