// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "./IACP.sol";
import "./IPolicy.sol";

/// @title EvaluatorRouter
/// @notice Immutable, non-proxy orchestration layer between ACP and Policy implementations.
///         Each V1 job sets job.evaluator = address(this); the router forwards verdicts from
///         a policy to ACP.complete / ACP.reject. Router code never changes.
contract EvaluatorRouter is ReentrancyGuardTransient {
    IACP    public immutable acp;
    address public admin;

    mapping(address => bool)    public policyWhitelist;
    mapping(uint256 => address) public jobPolicy;  // one-shot binding

    error ZeroAddress();
    error Unauthorized();
    error NotOpen();
    error WrongEvaluator();
    error NotWhitelisted();
    error AlreadyRegistered();
    error NotRegistered();
    error NotClient();
    error Pending();

    event PolicyWhitelistUpdated(address indexed policy, bool status);
    event JobRegistered(uint256 indexed jobId, address indexed policy);
    event JobSettled(uint256 indexed jobId, uint8 verdict, bytes32 reason);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(address _acp, address _admin) {
        if (_acp == address(0) || _admin == address(0)) revert ZeroAddress();
        acp = IACP(_acp);
        admin = _admin;
    }

    function registerJob(uint256 jobId, address policy) external {
        IACP.Job memory job = acp.getJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        if (job.status != IACP.JobStatus.Open) revert NotOpen();
        if (job.evaluator != address(this)) revert WrongEvaluator();
        if (!policyWhitelist[policy]) revert NotWhitelisted();
        if (jobPolicy[jobId] != address(0)) revert AlreadyRegistered();
        jobPolicy[jobId] = policy;
        emit JobRegistered(jobId, policy);
    }

    function settle(uint256 jobId, bytes calldata evidence) external nonReentrant {
        address policy = jobPolicy[jobId];
        if (policy == address(0)) revert NotRegistered();
        // Intentionally NOT re-checking policyWhitelist: binding commits the router
        (uint8 verdict, bytes32 evidenceHash) = IPolicy(policy).check(jobId, evidence);
        if (verdict != 1 && verdict != 2) revert Pending();
        bytes32 reason = keccak256(abi.encode(policy, verdict, evidenceHash));
        if (verdict == 1) acp.complete(jobId, reason, "");
        else              acp.reject(jobId,  reason, "");
        emit JobSettled(jobId, verdict, reason);
    }

    function setPolicyWhitelist(address policy, bool status) external onlyAdmin {
        if (policy == address(0)) revert ZeroAddress();
        policyWhitelist[policy] = status;
        emit PolicyWhitelistUpdated(policy, status);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
