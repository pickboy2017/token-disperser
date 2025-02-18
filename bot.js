const { ethers } = require("ethers");
const fs = require("fs");
const { Select, Confirm, Input } = require("enquirer");
const ora = require("ora");
const chains = require("./chains.json");

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

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

class BatchNonceManager {
  constructor(wallet, batchSize) {
    this.wallet = wallet;
    this.batchSize = batchSize;
    this.currentNonce = null;
    this.nextAvailable = 0;
  }

  async initialize() {
    this.currentNonce = await this.wallet.getNonce();
    this.nextAvailable = this.currentNonce;
  }

  async getNextBatchNonces(count) {
    if (!this.currentNonce) await this.initialize();
    const nonces = Array.from({length: count}, (_, i) => this.nextAvailable + i);
    this.nextAvailable += count;
    return nonces;
  }
}

async function main() {
  try {
    const chainPrompt = new Select({
      name: "network",
      message: `${colors.cyan}🌍 Select EVM network:${colors.reset}`,
      choices: chains.map(c => `${c.name} (${c.symbol}) - Chain ID: ${c.chainId}`)
    });

    const selectedChain = await chainPrompt.run();
    const chain = chains.find(c => selectedChain.includes(c.name));
    ora().succeed(`${colors.green}🌐 Selected: ${chain.name} (Chain ID ${chain.chainId})${colors.reset}`);

    const transferTypePrompt = new Select({
      name: "transferType",
      message: `${colors.cyan}💸 Select transfer type:${colors.reset}`,
      choices: ["Native Coin", "ERC20 Token"]
    });
    const transferType = await transferTypePrompt.run();
    const addressLoader = ora(`${colors.cyan}📖 Loading addresses from address.txt...${colors.reset}`).start();
    const addresses = fs.readFileSync("address.txt", "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => ethers.isAddress(l));
    addressLoader.succeed(`${colors.green}📄 Found ${addresses.length} valid addresses${colors.reset}`);

    const provider = await buildFallbackProvider(chain);
    ora().succeed(`${colors.green}🔗 Network locked to ${chain.name} (${chain.chainId})${colors.reset}`);

    const privateKey = await new Input({
      message: `${colors.yellow}🔑 Enter private key:${colors.reset}`,
      validate: (key) => {
        try {
          const hexKey = ethers.hexlify(key.startsWith("0x") ? key : `0x${key}`);
          if (!ethers.isHexString(hexKey) || hexKey.length !== 66) {
            return "Invalid private key (must be 64 hex characters)";
          }
          return true;
        } catch {
          return "Invalid private key format";
        }
      }
    }).run();

    const wallet = new ethers.Wallet(privateKey, provider);
    let tokenContract, symbol, decimals, parsedAmount;

    if (transferType === "ERC20 Token") {
      const tokenAddress = await new Input({
        message: `${colors.yellow}🏦 Enter ERC20 contract address:${colors.reset}`,
        validate: (addr) => ethers.isAddress(addr) ? true : "Invalid address"
      }).run();

      tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      
      const tokenDetailsSpinner = ora(`${colors.cyan}📦 Fetching token details...${colors.reset}`).start();
      try {
        [symbol, decimals] = await Promise.all([
          tokenContract.symbol(),
          tokenContract.decimals()
        ]);
        tokenDetailsSpinner.succeed(`${colors.green}Token: ${symbol} (Decimals: ${decimals})${colors.reset}`);
      } catch (error) {
        tokenDetailsSpinner.fail(`${colors.red}❌ Failed to fetch token details: ${error.shortMessage || error.message}${colors.reset}`);
        throw error;
      }

      const balanceSpinner = ora(`${colors.cyan}💰 Checking token balance...${colors.reset}`).start();
      try {
        const balance = await tokenContract.balanceOf(wallet.address);
        balanceSpinner.succeed(`${colors.green}Token Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}${colors.reset}`);
        
        const amount = await new Input({
          message: `${colors.yellow}💸 Amount to send (${symbol}):${colors.reset}`,
          validate: v => !isNaN(v) && v > 0 || "Must be a positive number"
        }).run();
        
        parsedAmount = ethers.parseUnits(amount, decimals);
        if (parsedAmount * BigInt(addresses.length) > balance) {
          throw new Error(`Insufficient token balance. Needed: ${
            ethers.formatUnits(parsedAmount * BigInt(addresses.length), decimals)
          } ${symbol}`);
        }
      } catch (error) {
        balanceSpinner.fail(`${colors.red}❌ Failed to check balance: ${error.shortMessage || error.message}${colors.reset}`);
        throw error;
      }
    } else {
      
      const balance = await provider.getBalance(wallet.address);
      ora().succeed(`${colors.green}💰 Native Coin Balance: ${ethers.formatEther(balance)} ${chain.symbol}${colors.reset}`);

      const amount = await new Input({
        message: `${colors.yellow}💸 Amount to send (${chain.symbol}):${colors.reset}`,
        validate: v => !isNaN(v) && v > 0 || "Must be a positive number"
      }).run();
      
      parsedAmount = ethers.parseEther(amount);
      if (parsedAmount * BigInt(addresses.length) > balance) {
        throw new Error(`Insufficient Native coin balance. Needed: ${
          ethers.formatEther(parsedAmount * BigInt(addresses.length))
        } ${chain.symbol}`);
      }
    }

    
    let gasParams = {};
    const useCustomGas = await new Confirm({ 
      message: `${colors.cyan}⛽ Use custom gas settings?${colors.reset}`
    }).run();

    const defaultGasLimit = transferType === "ERC20 Token" ? 60000 : 21000;
    if (useCustomGas) {
      gasParams = {
        maxFeePerGas: ethers.parseUnits(await new Input({
          message: `${colors.yellow}⛽ Max fee per gas (Gwei):${colors.reset}`,
          validate: v => !isNaN(v) && v > 0 || "Must be a positive number"
        }).run(), "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits(await new Input({
          message: `${colors.yellow}⚡ Priority fee (Gwei):${colors.reset}`,
          validate: v => !isNaN(v) && v > 0 || "Must be a positive number"
        }).run(), "gwei"),
        gasLimit: Number(await new Input({
          message: `${colors.yellow}🔢 Gas limit:${colors.reset}`,
          initial: defaultGasLimit.toString(),
          validate: v => !isNaN(v) && v >= defaultGasLimit || `Minimum ${defaultGasLimit} gas`
        }).run())
      };
    } else {
      gasParams = { gasLimit: defaultGasLimit };
    }


    const BATCH_SIZE = 5;
    const RETRY_ATTEMPTS = 3;
    const spinner = ora(`${colors.magenta}🔄️ Sending ${addresses.length} transactions...${colors.reset}`).start();
    
    let successCount = 0;
    const batchNonceManager = new BatchNonceManager(wallet, BATCH_SIZE);
    await batchNonceManager.initialize();

    for (let batchIndex = 0; batchIndex < addresses.length; batchIndex += BATCH_SIZE) {
      const batch = addresses.slice(batchIndex, batchIndex + BATCH_SIZE);
      const batchNonces = await batchNonceManager.getNextBatchNonces(batch.length);
      
      const transactions = batch.map((address, index) => {
        if (transferType === "ERC20 Token") {
          const erc20Interface = new ethers.Interface(ERC20_ABI);
          const data = erc20Interface.encodeFunctionData("transfer", [address, parsedAmount]);
          return {
            to: tokenContract.target,
            data: data,
            value: 0,
            nonce: batchNonces[index],
            ...gasParams
          };
        }
        return {
          to: address,
          value: parsedAmount,
          nonce: batchNonces[index],
          ...gasParams
        };
      });

      const results = await Promise.all(transactions.map(async (tx, index) => {
        let attempts = 0;
        while (attempts < RETRY_ATTEMPTS) {
          attempts++;
          try {
            const sentTx = await wallet.sendTransaction(tx);
            return {
              success: true,
              hash: sentTx.hash,
              address: tx.to === tokenContract?.target ? batch[index] : tx.to
            };
          } catch (error) {
            if (attempts === RETRY_ATTEMPTS) {
              return {
                success: false,
                error: error.shortMessage || error.message,
                code: error.code,
                address: tx.to === tokenContract?.target ? batch[index] : tx.to
              };
            }
            await new Promise(r => setTimeout(r, 1000 * attempts));
          }
        }
      }));

      for (const result of results) {
        const position = batchIndex + results.indexOf(result) + 1;
        if (result.success) {
          successCount++;
          const txLink = chain.explorer ? `${chain.explorer}${result.hash}` : result.hash;
          spinner.succeed(
            `${colors.green}✅ TX ${position}/${addresses.length}${colors.reset}\n` +
            `${colors.cyan}  📤 Receiver: ${result.address}${colors.reset}\n` +
            `${colors.cyan}  🔗 Tx hash: ${txLink}${colors.reset}\n`
          );
        } else {
          spinner.fail(
            `${colors.red}❌ TX ${position}/${addresses.length}${colors.reset}\n` +
            `${colors.yellow}   📤 To: ${result.address}${colors.reset}\n` +
            `${colors.red}   💥 Error: ${result.error} (code ${result.code})${colors.reset}\n` +
            `${colors.yellow}   ⚠️ Attempts: ${RETRY_ATTEMPTS}${colors.reset}\n`
          );
        }
      }
    }


    const totalSent = parsedAmount * BigInt(successCount);
    const formattedTotal = transferType === "ERC20 Token" 
      ? `${ethers.formatUnits(totalSent, decimals)} ${symbol}`
      : `${ethers.formatEther(totalSent)} ${chain.symbol}`;

    const successRate = ((successCount / addresses.length) * 100).toFixed(2);
    spinner.succeed(`${colors.green}
✨ All transactions completed!
   🌐 Network: ${chain.name} (ID ${chain.chainId})
   👛 Sender Wallet: ${wallet.address}
   💸 Total Sent: ${formattedTotal}
   📦 Success Rate: ${successCount}/${addresses.length} (${successRate}%)${colors.reset}`);
   
  } catch (error) {
    ora().fail(`${colors.red}🔥 Critical Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
