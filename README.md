<h2 align=center>Token Disperser Bot</h2>

A simple and efficient script to batch-send native or ERC-20 tokens from one wallet to multiple recipients. Ideal for airdrops, bulk payments, or token distributions.

## 🔧 Installation

### 1️⃣ Install cURL (if not installed)  
```bash
sudo apt update && sudo apt install -y curl
```

### 2️⃣ Install Git (if not installed)
```bash
curl -sSL https://raw.githubusercontent.com/zunxbt/installation/main/git.sh | bash
```
### 3️⃣ Clone the Repository
```bash
git clone https://github.com/zunxbt/token-disperser && cd token-disperser
```
### 4️⃣ Install Node.js and npm
```bash
curl -sSL https://raw.githubusercontent.com/zunxbt/installation/main/node.sh | bash
```
### 5️⃣ Install Dependencies
```bash
npm install enquirer@2.4.1 ethers@6.13.5 node-fetch@3.3.2 ora@5.4.1
```

## 📂 Configuration
- Open `address.txt` file to input recipient wallet addresses, one per line
```bash
nano address.txt
```
- After entering all addresses, save the file using `Ctrl + X` and the press `Y` and then press `Enter`

## 🚀 Running the Script


https://github.com/user-attachments/assets/5f804a6c-a5ae-40f5-8edf-eb99c5c75321


- To start sending tokens, use the below command
```bash
node bot.js
```
- After running at the last stage it will ask `⛽ Use custom gas settings? (y/N)` ; if u want to use current gas fee then write `N` but if u want to use customized gas fee instead of current gas fee then u should write `y`
## ⚠️ Important Notes
- You need to enter the **private key** of the wallet from which you want to send tokens to other wallets.
- Choose the **Native Coin** option if you want to send gas tokens like **BNB, ETH, or IP**. If you want to send an **ERC-20 token**, you need to enter the **contract address** of that token.
- If the **network you want to use is not available**, you can edit the `chains.json` file and modify it with your preferred network.
