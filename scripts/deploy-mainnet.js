// scripts/deploy-mainnet.js
// Canonical mainnet deployment — production hardened
// Usage: source .env && npx hardhat run scripts/deploy-mainnet.js --network monadMainnet

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function mustEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env: ${k}`);
  return v;
}

function optEnv(k, def = "") {
  const v = process.env[k];
  return v !== undefined && v !== "" ? v : def;
}

function isHexAddress(a) {
  return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
}

async function codeAt(addr) {
  if (!addr || addr === ethers.ZeroAddress) return "0x";
  return await ethers.provider.getCode(addr);
}

function nowIso() {
  return new Date().toISOString();
}

function safeGitCommit() {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch { return ""; }
}

async function main() {
  const dryrun = optEnv("DRYRUN", "") === "1";
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const networkName = hre.network.name;
  const chainId = Number(net.chainId);

  console.log(`=== MMM Canonical Mainnet Deploy (${networkName} #${chainId}) ===`);
  console.log("deployer :", deployer.address);
  console.log("dryrun   :", dryrun);

  // === Required addresses (mainnet) ===
  const ROUTER_ADDR = mustEnv("MONAD_MAINNET_ROUTER");
  const FACTORY_ADDR = mustEnv("MONAD_MAINNET_FACTORY");
  const WMON_ADDR = mustEnv("WMON_ADDR");
  const USDC_ADDR = mustEnv("USDC_ADDR");

  const TIMELOCK_ADDR = mustEnv("TIMELOCK_ADDR"); // LP lock target (Gnosis Safe/Timelock)

  if (!isHexAddress(ROUTER_ADDR) || !isHexAddress(FACTORY_ADDR) || 
      !isHexAddress(WMON_ADDR) || !isHexAddress(USDC_ADDR) || 
      !isHexAddress(TIMELOCK_ADDR)) {
    throw new Error("One or more DEX/lock addresses invalid");
  }

  // Pre-flight contract checks
  for (const [name, addr] of Object.entries({ ROUTER: ROUTER_ADDR, FACTORY: FACTORY_ADDR, WMON: WMON_ADDR, USDC: USDC_ADDR })) {
    if ((await codeAt(addr)) === "0x") throw new Error(`${name} has no code at ${addr}`);
  }

  // === Token params ===
  const NAME = optEnv("MMM_NAME", "Monad Money Machine");
  const SYMBOL = optEnv("MMM_SYMBOL", "MMM");
  const SUPPLY_TOKENS = optEnv("MMM_SUPPLY_TOKENS", "1000000000");
  const supplyRaw = ethers.parseUnits(SUPPLY_TOKENS, 18);

  const MIN_HOLD_SEC = BigInt(optEnv("MIN_HOLD_SEC", "43200"));
  const COOLDOWN_SEC = BigInt(optEnv("COOLDOWN_SEC", "43200"));
  const MIN_BALANCE = BigInt(optEnv("MIN_BALANCE", ethers.parseUnits("1", 18).toString()));

  const BUY_TAX_BPS = BigInt(optEnv("BUY_TAX_BPS", "500"));
  const SELL_TAX_BPS = BigInt(optEnv("SELL_TAX_BPS", "500"));

  console.log("Params:", { NAME, SYMBOL, SUPPLY_TOKENS, MIN_HOLD_SEC: MIN_HOLD_SEC.toString(), ... });

  if (dryrun) {
    console.log("DRYRUN — stopping before any tx.");
    return;
  }

  // 1. Deploy MMMToken
  const MMMFactory = await ethers.getContractFactory("MMMToken");
  const mmm = await MMMFactory.deploy(NAME, SYMBOL, supplyRaw, deployer.address);
  await mmm.waitForDeployment();
  const MMM_ADDR = await mmm.getAddress();
  console.log("MMMToken:", MMM_ADDR);

  // 2. Deploy TaxVault
  const TaxVaultFactory = await ethers.getContractFactory("TaxVault");
  const tv = await TaxVaultFactory.deploy(MMM_ADDR, USDC_ADDR, WMON_ADDR, deployer.address);
  await tv.waitForDeployment();
  const TAX_VAULT = await tv.getAddress();
  console.log("TaxVault:", TAX_VAULT);

  // 3. Deploy RewardVault (current ctor: mmm, minHold, cooldown, minBal, owner)
  const RewardVaultFactory = await ethers.getContractFactory("RewardVault");
  const rv = await RewardVaultFactory.deploy(
    MMM_ADDR,
    Number(MIN_HOLD_SEC),
    Number(COOLDOWN_SEC),
    MIN_BALANCE,
    deployer.address
  );
  await rv.waitForDeployment();
  const REWARD_VAULT = await rv.getAddress();
  console.log("RewardVault:", REWARD_VAULT);

  // 4. Wire once
  {
    const tx = await tv.wireOnce(REWARD_VAULT, deployer.address /* marketing */, deployer.address /* team — update later */);
    await tx.wait();
    console.log("TaxVault.wireOnce tx:", tx.hash);
  }
  {
    const tx = await mmm.setTaxVaultOnce(TAX_VAULT);
    await tx.wait();
    console.log("MMM.setTaxVaultOnce tx:", tx.hash);
  }
  {
    const tx = await mmm.setRewardVaultOnce(REWARD_VAULT);
    await tx.wait();
    console.log("MMM.setRewardVaultOnce tx:", tx.hash);
  }

  // 5. Router + Pair
  {
    const tx = await mmm.setRouter(ROUTER_ADDR);
    await tx.wait();
  }

  const factoryAbi = ["function getPair(address,address) view returns (address)", "function createPair(address,address) returns (address)"];
  const factory = await ethers.getContractAt(factoryAbi, FACTORY_ADDR);
  let pair = await factory.getPair(MMM_ADDR, WMON_ADDR);
  if (pair === ethers.ZeroAddress) {
    const tx = await factory.createPair(MMM_ADDR, WMON_ADDR);
    await tx.wait();
    pair = await factory.getPair(MMM_ADDR, WMON_ADDR);
  }
  console.log("Pair:", pair);

  {
    const tx = await mmm.setPair(pair);
    await tx.wait();
  }

  // 6. Taxes + Launch
  {
    const tx = await mmm.setTaxes(BUY_TAX_BPS, SELL_TAX_BPS);
    await tx.wait();
  }
  {
    const tx = await mmm.launch();
    await tx.wait();
    console.log("Launched at", (await mmm.launchTime()).toString());
  }

  // 7. LP lock to Timelock (transfer LP ownership)
  const pairContract = await ethers.getContractAt(["function transferOwnership(address)"], pair);
  {
    const tx = await pairContract.transferOwnership(TIMELOCK_ADDR);
    await tx.wait();
    console.log(`LP locked to Timelock: ${TIMELOCK_ADDR}`);
  }

  // === Post-deploy assertions ===
  console.log("\n=== POST-DEPLOY ASSERTIONS ===");
  if ((await mmm.taxVault()) !== TAX_VAULT) throw new Error("TaxVault wiring failed");
  if ((await mmm.rewardVault()) !== REWARD_VAULT) throw new Error("RewardVault wiring failed");
  if (!(await mmm.tradingEnabled())) throw new Error("Trading not enabled");
  if ((await mmm.pair()) !== pair) throw new Error("Pair mismatch");
  if ((await tv.rewardVault()) !== REWARD_VAULT) throw new Error("TaxVault -> RewardVault mismatch");

  const mmmBal = await mmm.balanceOf(deployer.address);
  if (mmmBal !== supplyRaw) throw new Error("Supply mismatch");

  console.log("✅ All assertions passed.");

  // === Manifest ===
  const manifest = {
    network: networkName,
    chainId,
    deployedAt: nowIso(),
    gitCommit: safeGitCommit(),
    deployer: deployer.address,
    contracts: {
      MMMToken: MMM_ADDR,
      TaxVault: TAX_VAULT,
      RewardVault: REWARD_VAULT,
      Pair: pair,
      Router: ROUTER_ADDR,
      Timelock: TIMELOCK_ADDR
    },
    params: { supply: SUPPLY_TOKENS, minHold: MIN_HOLD_SEC.toString(), ... }
  };

  const deployDir = path.join(__dirname, "..", "deployments", networkName);
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });
  const manifestPath = path.join(deployDir, "latest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("Manifest written:", manifestPath);

  // === Verify ===
  console.log("\nVerifying on Etherscan...");
  try {
    await hre.run("verify:verify", { address: MMM_ADDR, constructorArguments: [NAME, SYMBOL, supplyRaw, deployer.address] });
    await hre.run("verify:verify", { address: TAX_VAULT, constructorArguments: [MMM_ADDR, USDC_ADDR, WMON_ADDR, deployer.address] });
    await hre.run("verify:verify", { address: REWARD_VAULT, constructorArguments: [MMM_ADDR, Number(MIN_HOLD_SEC), Number(COOLDOWN_SEC), MIN_BALANCE, deployer.address] });
    console.log("✅ Verified");
  } catch (e) {
    console.warn("Verify warning:", e.message);
  }

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log("Next: Transfer ownership of MMM/TaxVault/RewardVault to multisig/timelock.");
  console.log("Review unsigned tx artifacts if using --dryrun or ledger.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
