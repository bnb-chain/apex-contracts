import "@nomicfoundation/hardhat-ethers";

import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";
import * as fs from "fs";

// Load the specified env file. dotenv v17 auto-injects .env before any code runs,
// so override:true ensures DOTENV_CONFIG_PATH values take precedence.
const envPath = process.env.DOTENV_CONFIG_PATH || ".env";
if (!fs.existsSync(envPath)) {
  console.error(`\x1b[31mFATAL: env file not found: ${envPath}\x1b[0m`);
  process.exit(1);
}
dotenv.config({ path: envPath, override: true });
console.log(`[hardhat] env loaded from ${envPath}`);

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
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
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
