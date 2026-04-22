// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./IACP.sol";
import "./IPolicy.sol";

/// @title OptimisticPolicy
/// @notice V1 strategy: silence-means-approve + whitelisted-voter-rejects. Immutable params.
contract OptimisticPolicy is IPolicy {
    IACP    public immutable acp;
    address public immutable router;
    uint64  public immutable disputeWindow;
    uint16  public immutable voteQuorum;

    address public admin;

    mapping(uint256 => bool)   public disputed;
    mapping(uint256 => uint16) public rejectVotes;
    mapping(uint256 => mapping(address => bool)) public voted;

    mapping(address => bool) public isVoter;
    uint16 public activeVoterCount;

    error ZeroAddress();
    error ZeroQuorum();
    error VotersBelowQuorum();
    error DuplicateVoter();
    error Unauthorized();
    error NotSubmitted();
    error WindowClosed();
    error AlreadyDisputed();
    error NoDispute();
    error AlreadyVoted();
    error NotVoter();
    error WouldDropBelowQuorum();

    event Disputed(uint256 indexed jobId, address indexed client);
    event VoteRejected(uint256 indexed jobId, address indexed voter, uint16 newCount);
    /// @notice Emitted once per job, on the exact vote that reaches voteQuorum.
    ///         Consumers can listen to this to trigger router.settle() or notify clients.
    event QuorumReached(uint256 indexed jobId, uint16 voteCount);
    event VoterAdded(address indexed voter);
    event VoterRemoved(address indexed voter);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin()  { if (msg.sender != admin)  revert Unauthorized(); _; }
    modifier onlyRouter() { if (msg.sender != router) revert Unauthorized(); _; }

    constructor(
        address _acp,
        address _router,
        uint64  _disputeWindow,
        uint16  _voteQuorum,
        address _admin,
        address[] memory initialVoters
    ) {
        if (_acp == address(0) || _router == address(0) || _admin == address(0)) revert ZeroAddress();
        if (_voteQuorum == 0) revert ZeroQuorum();
        if (initialVoters.length < _voteQuorum) revert VotersBelowQuorum();
        acp = IACP(_acp);
        router = _router;
        disputeWindow = _disputeWindow;
        voteQuorum = _voteQuorum;
        admin = _admin;
        for (uint256 i = 0; i < initialVoters.length; i++) {
            address v = initialVoters[i];
            if (v == address(0)) revert ZeroAddress();
            if (isVoter[v]) revert DuplicateVoter();
            isVoter[v] = true;
            emit VoterAdded(v);
        }
        activeVoterCount = uint16(initialVoters.length);
    }

    function dispute(uint256 jobId) external {
        IACP.Job memory job = acp.getJob(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != IACP.JobStatus.Submitted) revert NotSubmitted();
        if (block.timestamp >= uint256(job.submittedAt) + disputeWindow) revert WindowClosed();
        if (disputed[jobId]) revert AlreadyDisputed();
        disputed[jobId] = true;
        emit Disputed(jobId, msg.sender);
    }

    function voteReject(uint256 jobId) external {
        if (!isVoter[msg.sender]) revert NotVoter();
        if (!disputed[jobId]) revert NoDispute();
        if (voted[jobId][msg.sender]) revert AlreadyVoted();
        voted[jobId][msg.sender] = true;
        uint16 newCount = ++rejectVotes[jobId];
        emit VoteRejected(jobId, msg.sender, newCount);
        // Fires exactly once per job — the vote that crosses the threshold.
        if (newCount == voteQuorum) {
            emit QuorumReached(jobId, newCount);
        }
    }

    function check(uint256 jobId, bytes calldata /* evidence */)
        external view onlyRouter returns (uint8, bytes32)
    {
        IACP.Job memory job = acp.getJob(jobId);
        if (job.status != IACP.JobStatus.Submitted) revert NotSubmitted();

        // Rule 1: disputed + enough rejects → Reject
        if (disputed[jobId] && rejectVotes[jobId] >= voteQuorum) {
            return (2, keccak256(abi.encode(jobId, "REJECTED", rejectVotes[jobId], job.submittedAt)));
        }
        // Rule 2: not disputed + window elapsed → Approve
        if (!disputed[jobId] && block.timestamp >= uint256(job.submittedAt) + disputeWindow) {
            return (1, keccak256(abi.encode(jobId, "AUTO_APPROVED", job.submittedAt)));
        }
        // Rule 3: Pending
        return (0, bytes32(0));
    }

    function addVoter(address v) external onlyAdmin {
        if (v == address(0)) revert ZeroAddress();
        if (isVoter[v]) revert DuplicateVoter();
        isVoter[v] = true;
        activeVoterCount++;
        emit VoterAdded(v);
    }

    function removeVoter(address v) external onlyAdmin {
        if (!isVoter[v]) revert NotVoter();
        if (activeVoterCount - 1 < voteQuorum) revert WouldDropBelowQuorum();
        isVoter[v] = false;
        activeVoterCount--;
        emit VoterRemoved(v);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
