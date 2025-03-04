const { ethers } = require("ethers");
const fs = require("fs");
const { default: ora } = require("ora");
const chains = require("./chains.json");
require('dotenv').config(); // Load environment variables from .env file

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

async function createValidProvider(url, chain) {
  const provider = new ethers.JsonRpcProvider(url);
  const staticNetwork = { 
    name: chain.name,
    chainId: BigInt(chain.chainId),
    getPlugin: () => null,
    _defaultProvider: (providers) => new ethers.FallbackProvider(providers)
  };

  provider.getNetwork = async () => staticNetwork;
  provider.detectNetwork = async () => staticNetwork;
  
  try {
    const actualChainId = (await provider.getNetwork()).chainId;
    if (actualChainId !== staticNetwork.chainId) {
      throw new Error(`Chain ID mismatch: Expected ${chain.chainId} got ${actualChainId}`);
    }
    await provider.getBlockNumber();
    return provider;
  } catch (error) {
    throw new Error(`RPC Failed: ${url} - ${error.message}`);
  }
}

async function buildFallbackProvider(chain) {
  const spinner = ora(`${colors.yellow}🔍 Validating RPC endpoints for ${chain.name}...${colors.reset}`).start();
  const providers = [];

  for (const url of chain.rpc) {
    try {
      const provider = await createValidProvider(url, chain);
      providers.push(provider);
      spinner.succeed(`${colors.green}✅ Valid RPC: ${url}${colors.reset}`);
      spinner.start();
    } catch (error) {
      spinner.fail(`${colors.red}❌ Invalid RPC: ${url} - ${error.message}${colors.reset}`);
    }
  }

  spinner.stop();
  
  if (providers.length === 0) {
    throw new Error("No working RPC endpoints available");
  }

  const fallbackProvider = new ethers.FallbackProvider(providers, 1);
  const enforcedNetwork = {
    name: chain.name,
    chainId: BigInt(chain.chainId),
    getPlugin: () => null,
    _defaultProvider: (providers) => new ethers.FallbackProvider(providers)
  };

  fallbackProvider.getNetwork = async () => enforcedNetwork;
  fallbackProvider.detectNetwork = async () => enforcedNetwork;

  return fallbackProvider;
}

async function main() {
  try {
    // Directly use the first network in chains.json
    const chain = chains[0];
    ora().succeed(`${colors.green}🌐 Selected: ${chain.name} (Chain ID ${chain.chainId})${colors.reset}`);

    // Load addresses from address.txt
    const addressLoader = ora(`${colors.cyan}📖 Loading addresses from address.txt...${colors.reset}`).start();
    const addresses = fs.readFileSync("address.txt", "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => ethers.isAddress(l));
    addressLoader.succeed(`${colors.green}📄 Found ${addresses.length} valid addresses${colors.reset}`);

    // Load private key from .env
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("Private key not found in .env file");
    }

    const provider = await buildFallbackProvider(chain);
    ora().succeed(`${colors.green}🔗 Network locked to ${chain.name} (${chain.chainId})${colors.reset}`);

    const wallet = new ethers.Wallet(privateKey, provider);

    // Function to check balance and send funds
    const checkBalanceAndSend = async () => {
      const balance = await provider.getBalance(wallet.address);
      const gasFee = ethers.parseEther("0.00016"); // Hardcoded gas fee
      const sendAmount = balance - gasFee;

      if (sendAmount > 0) {
        const spinner = ora(`${colors.magenta}🔄️ Sending ${ethers.formatEther(sendAmount)} ${chain.symbol}...${colors.reset}`).start();

        const tx = {
          to: addresses[0], // Send to the first address in address.txt
          value: sendAmount
        };

        try {
          const sentTx = await wallet.sendTransaction(tx);
          spinner.succeed(`${colors.green}✅ Transaction sent: ${sentTx.hash}${colors.reset}`);
        } catch (error) {
          spinner.fail(`${colors.red}❌ Failed to send transaction: ${error.message}${colors.reset}`);
        }
      } else {
        ora().info(`${colors.yellow}⚠️ Insufficient balance to send after gas fee${colors.reset}`);
      }
    };

    // Check balance and send every second
    setInterval(checkBalanceAndSend, 1000);

  } catch (error) {
    ora().fail(`${colors.red}🔥 Critical Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main(); // Remove process.exit(0) to keep the script running
