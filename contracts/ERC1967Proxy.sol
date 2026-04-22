// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Symbol-level rename avoids a name collision between this file's local contract and
// OZ's upstream `ERC1967Proxy`. See the Solidity docs on importing:
// https://docs.soliditylang.org/en/latest/layout-of-source-files.html#importing-other-source-files
import {ERC1967Proxy as OZERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title ERC1967Proxy (test helper)
/// @notice Re-exports OZ's ERC1967Proxy under a local hardhat artifact name so tests
///         and deployment scripts can reference it as `"ERC1967Proxy"`. No behavioural
///         change over the upstream contract.
contract ERC1967Proxy is OZERC1967Proxy {
    constructor(address implementation, bytes memory data_) OZERC1967Proxy(implementation, data_) {}
}
