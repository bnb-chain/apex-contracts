import "@nomicfoundation/hardhat-ethers";

import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY || "",
    }
  },

  chainDescriptors: {
    97: {
      name: "BSC Testnet",
      blockExplorers: {
        etherscan: {
          url: "https://testnet.bscscan.com",
          apiUrl: "https://api.etherscan.io/v2/api",
        }
      }
    },
    56: {
      name: "BSC Mainnet",
      blockExplorers: {
        etherscan: {
          url: "https://bscscan.com",
          apiUrl: "https://api.etherscan.io/v2/api",
        }
      }
    }
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          evmVersion: "shanghai",
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.24",
        settings: {
          evmVersion: "shanghai",
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    bscTestnetFork: {
      type: "edr-simulated",
      chainType: "l1",
      forking: {
        url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-2-s3.binance.org:8545",
      },
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
    bscTestnet: {
      type: "http",
      chainType: "l1",
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-2-s3.binance.org:8545",
      accounts: process.env.BSC_TESTNET_PRIVATE_KEY ? [process.env.BSC_TESTNET_PRIVATE_KEY] : [],
    },
    bsc: {
      type: "http",
      chainType: "l1",
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      accounts: process.env.BSC_PRIVATE_KEY ? [process.env.BSC_PRIVATE_KEY] : [],
    },
  },
};

export default config;
