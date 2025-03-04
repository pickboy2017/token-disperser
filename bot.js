const { ethers } = require("ethers");
const fs = require("fs");
const ora = require("ora");
const dotenv = require("dotenv");
const chains = require("./chains.json");
const config = require("./config.json");

// Load environment variables
dotenv.config();

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

// Rate limiting function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

async function transferFunds(wallet, provider, addresses, chain) {
  const BATCH_SIZE = config.batchSize || 10; // Increased batch size
  const RETRY_ATTEMPTS = config.retryAttempts || 3;
  const RATE_LIMIT_DELAY = config.rateLimitDelay || 500; // Reduced delay

  const balance = await provider.getBalance(wallet.address);
  if (balance === 0n) {
    ora().info(`${colors.yellow}💰 No balance available in wallet ${wallet.address}${colors.reset}`);
    return;
  }

  const parsedAmount = balance / BigInt(addresses.length);
  if (parsedAmount === 0n) {
    ora().warn(`${colors.yellow}⚠️ Balance too low to distribute among ${addresses.length} addresses${colors.reset}`);
    return;
  }

  const gasParams = { gasLimit: 21000 }; // Default gas limit for native transfers

  // Pre-calculate all transaction data
  const transactions = addresses.map((address, index) => ({
    to: address,
    value: parsedAmount,
    nonce: wallet.nonce + BigInt(index), // Pre-calculate nonces
    ...gasParams
  }));

  // Send all transactions in parallel
  const results = await Promise.all(transactions.map(async (tx, index) => {
    let attempts = 0;
    while (attempts < RETRY_ATTEMPTS) {
      attempts++;
      try {
        const sentTx = await wallet.sendTransaction(tx);
        return {
          success: true,
          hash: sentTx.hash,
          address: tx.to
        };
      } catch (error) {
        if (attempts === RETRY_ATTEMPTS) {
          return {
            success: false,
            error: error.shortMessage || error.message,
            code: error.code,
            address: tx.to
          };
        }
        await delay(RATE_LIMIT_DELAY * attempts); // Rate limiting
      }
    }
  }));

  // Log results
  for (const result of results) {
    const position = results.indexOf(result) + 1;
    if (result.success) {
      const txLink = chain.explorer ? `${chain.explorer}${result.hash}` : result.hash;
      ora().succeed(
        `${colors.green}✅ TX ${position}/${addresses.length}${colors.reset}\n` +
        `${colors.cyan}  📤 Receiver: ${result.address}${colors.reset}\n` +
        `${colors.cyan}  🔗 Tx hash: ${txLink}${colors.reset}\n`
      );
    } else {
      ora().fail(
        `${colors.red}❌ TX ${position}/${addresses.length}${colors.reset}\n` +
        `${colors.yellow}   📤 To: ${result.address}${colors.reset}\n` +
        `${colors.red}   💥 Error: ${result.error} (code ${result.code})${colors.reset}\n` +
        `${colors.yellow}   ⚠️ Attempts: ${RETRY_ATTEMPTS}${colors.reset}\n`
      );
    }
  }

  const totalSent = parsedAmount * BigInt(addresses.length);
  ora().succeed(`${colors.green}
✨ All transactions completed!
   🌐 Network: ${chain.name} (ID ${chain.chainId})
   👛 Sender Wallet: ${wallet.address}
   💸 Total Sent: ${ethers.formatEther(totalSent)} ${chain.symbol}${colors.reset}`);
}

async function main() {
  try {
    // Load private key from environment variable
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("Private key not found in .env file");
    }

    // Load addresses
    const addresses = fs.readFileSync("address.txt", "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => ethers.isAddress(l));

    if (addresses.length === 0) {
      throw new Error("No valid addresses found in address.txt");
    }

    // Select the first chain (or modify to support multiple chains)
    const chain = chains[0];
    const provider = await buildFallbackProvider(chain);

    const wallet = new ethers.Wallet(privateKey, provider);

    // Continuously monitor balance and transfer funds
    ora().info(`${colors.cyan}👀 Monitoring wallet balance for ${wallet.address}...${colors.reset}`);
    while (true) {
      const balance = await provider.getBalance(wallet.address);
      if (balance > 0n) {
        ora().info(`${colors.green}💰 Detected balance: ${ethers.formatEther(balance)} ${chain.symbol}${colors.reset}`);
        await transferFunds(wallet, provider, addresses, chain);
      } else {
        ora().info(`${colors.yellow}🕒 No balance detected. Retrying in 5 seconds...${colors.reset}`);
      }
      await delay(5000); // Check balance every 5 seconds
    }
  } catch (error) {
    ora().fail(`${colors.red}🔥 Critical Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
