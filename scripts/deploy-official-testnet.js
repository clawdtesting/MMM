const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("================================================");
  console.log("OFFICIAL MMM TESTNET DEPLOY");
  console.log("Deployer:", deployer.address);
  console.log("================================================\n");

  // 3 multisig owners for MarketingVault and TeamVestingVault
  // Using deployer for all 3 on testnet – change for mainnet
  const MULTISIG_OWNERS = [
    deployer.address,
    process.env.TESTNET_MULTISIG_2 || deployer.address,
    process.env.TESTNET_MULTISIG_3 || deployer.address,
  ];

  // Validate no duplicate owners (required by TwoOfThreeERC20Vault)
  const unique = new Set(MULTISIG_OWNERS);
  if (unique.size !== 3) {
    throw new Error(
      "MULTISIG owners must be 3 unique addresses. Set TESTNET_MULTISIG_2 and TESTNET_MULTISIG_3 in .env"
    );
  }

  /* ============================================================
     1. Deploy WETH9 (WMON)
  ============================================================ */
  const WETH = await ethers.getContractFactory("WETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();
  const WETH_ADDR = await weth.getAddress();
  console.log("WMON deployed:          ", WETH_ADDR);

  /* ============================================================
     2. Deploy Mock USDC (6 decimals)
  ============================================================ */
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6, deployer.address);
  await usdc.waitForDeployment();
  const USDC_ADDR = await usdc.getAddress();
  console.log("USDC deployed:          ", USDC_ADDR);

  await (await usdc.mint(deployer.address, ethers.parseUnits("1000000", 6))).wait();
  console.log("USDC minted to deployer.");

  /* ============================================================
     3. Deploy Uniswap Factory
  ============================================================ */
  const Factory = await ethers.getContractFactory("UniswapV2Factory");
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  const FACTORY_ADDR = await factory.getAddress();
  console.log("Factory deployed:       ", FACTORY_ADDR);

  /* ============================================================
     3.5. Compute INIT_CODE_HASH and patch Router bytecode
          The UniswapV2Router uses a hardcoded keccak256(pair bytecode)
          inside UniswapV2Library.pairFor() to compute pair addresses.
          We grab the compiled Pair bytecode, hash it, find the old
          hardcoded hash inside the compiled Router bytecode, and swap
          it in-memory before deploying — no Solidity edits needed.
  ============================================================ */
  const Pair = await ethers.getContractFactory("UniswapV2Pair");
  const realInitCodeHash = ethers.keccak256(Pair.bytecode);
  console.log("\nINIT_CODE_HASH (real):  ", realInitCodeHash);

  // The canonical Uniswap v2 hash that is hardcoded in the library.
  // If your library uses a different placeholder, add it to this array.
  const KNOWN_PLACEHOLDERS = [
    "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f", // mainnet default
    "e18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303", // common fork variant
  ];

  const Router = await ethers.getContractFactory("UniswapV2Router02");
  let routerBytecode = Router.bytecode;

  // Strip 0x, work in lowercase hex
  const realHashHex = realInitCodeHash.slice(2).toLowerCase();
  let patched = false;

  for (const placeholder of KNOWN_PLACEHOLDERS) {
    if (routerBytecode.toLowerCase().includes(placeholder)) {
      // Replace ALL occurrences (there are usually 2: one in each swap helper)
      const regex = new RegExp(placeholder, "gi");
      routerBytecode = routerBytecode.replace(regex, realHashHex);
      console.log(`Patched Router bytecode: replaced '${placeholder}' → '${realHashHex}'`);
      patched = true;
      break;
    }
  }

  if (!patched) {
    // Auto-detect: the old hash must be a 32-byte (64 hex char) sequence
    // that appears in the bytecode. We log a warning but still try to deploy.
    // You can copy the real hash above and add it to KNOWN_PLACEHOLDERS.
    console.warn(
      "\n⚠️  WARNING: Could not find a known INIT_CODE_HASH placeholder in Router bytecode."
    );
    console.warn(
      "   The router may have been compiled with the correct hash already,"
    );
    console.warn(
      "   or the placeholder differs. Deploying as-is and verifying post-deploy.\n"
    );
  }

  /* ============================================================
     4. Deploy Uniswap Router02 (with patched bytecode)
  ============================================================ */
  // Build a ContractFactory using the (potentially patched) bytecode
  // but the original ABI, then deploy normally.
  const PatchedRouter = new ethers.ContractFactory(
    Router.interface,
    routerBytecode,
    deployer
  );

  const router = await PatchedRouter.deploy(FACTORY_ADDR, WETH_ADDR);
  await router.waitForDeployment();
  const ROUTER_ADDR = await router.getAddress();
  console.log("Router deployed:        ", ROUTER_ADDR);

  // ── Sanity check: getAmountsOut on a fake path just to confirm
  //    library routing works (will fail at pair lookup, not at hash level)
  // We do a real verification after the pair is created (step 11.5).

  /* ============================================================
     5. Deploy MMM Token
  ============================================================ */
  const MMM = await ethers.getContractFactory("MMMToken");
  const initialSupply = ethers.parseUnits("1000000000", 18); // 1B
  const mmm = await MMM.deploy(
    "Monad Money Machine",
    "MMM",
    initialSupply,
    deployer.address
  );
  await mmm.waitForDeployment();
  const MMM_ADDR = await mmm.getAddress();
  console.log("MMM deployed:           ", MMM_ADDR);

  /* ============================================================
     6. Deploy TaxVault
  ============================================================ */
  const TaxVault = await ethers.getContractFactory("TaxVault");
  const taxVault = await TaxVault.deploy(
    MMM_ADDR,
    USDC_ADDR,
    WETH_ADDR,
    deployer.address
  );
  await taxVault.waitForDeployment();
  const TAXVAULT_ADDR = await taxVault.getAddress();
  console.log("TaxVault deployed:      ", TAXVAULT_ADDR);

  /* ============================================================
     7. Deploy RewardVault
  ============================================================ */
  const RewardVault = await ethers.getContractFactory("RewardVault");
  const rewardVault = await RewardVault.deploy(
    MMM_ADDR,
    7 * 24 * 3600,
    24 * 3600,
    ethers.parseUnits("1000", 18),
    deployer.address
  );
  await rewardVault.waitForDeployment();
  const REWARDVAULT_ADDR = await rewardVault.getAddress();
  console.log("RewardVault deployed:   ", REWARDVAULT_ADDR);

  /* ============================================================
     8. Deploy MarketingVault (2-of-3 multisig, holds USDC)
  ============================================================ */
  const MarketingVault = await ethers.getContractFactory("MarketingVault");
  const marketingVault = await MarketingVault.deploy(USDC_ADDR, MULTISIG_OWNERS);
  await marketingVault.waitForDeployment();
  const MARKETINGVAULT_ADDR = await marketingVault.getAddress();
  console.log("MarketingVault deployed:", MARKETINGVAULT_ADDR);

  /* ============================================================
     9. Deploy TeamVestingVault (2-of-3 multisig, holds USDC)
  ============================================================ */
  const TeamVestingVault = await ethers.getContractFactory("TeamVestingVault");
  const teamVestingVault = await TeamVestingVault.deploy(USDC_ADDR, MULTISIG_OWNERS);
  await teamVestingVault.waitForDeployment();
  const TEAMVESTINGVAULT_ADDR = await teamVestingVault.getAddress();
  console.log("TeamVestingVault deployed:", TEAMVESTINGVAULT_ADDR);

  /* ============================================================
     10. Deploy BoostNFT
  ============================================================ */
  const BoostNFT = await ethers.getContractFactory("BoostNFT");
  const boostNFT = await BoostNFT.deploy(deployer.address);
  await boostNFT.waitForDeployment();
  const BOOSTNFT_ADDR = await boostNFT.getAddress();
  console.log("BoostNFT deployed:      ", BOOSTNFT_ADDR);

  /* ============================================================
     11. Create MMM / WMON Pair
  ============================================================ */
  await (await factory.createPair(MMM_ADDR, WETH_ADDR)).wait();
  const PAIR_ADDR = await factory.getPair(MMM_ADDR, WETH_ADDR);
  console.log("Pair created:           ", PAIR_ADDR);

  /* ============================================================
     11.5. Verify the hash patch worked — getAmountsOut must succeed
  ============================================================ */
  console.log("\nVerifying INIT_CODE_HASH patch...");
  const ROUTER_ABI = [
    "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  ];
  const routerView = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, deployer);
  try {
    const amounts = await routerView.getAmountsOut(
      ethers.parseEther("1"),
      [WETH_ADDR, MMM_ADDR]
    );
    console.log(
      "✅ getAmountsOut works! 1 WMON →",
      ethers.formatUnits(amounts[1], 18),
      "MMM"
    );
  } catch (e) {
    console.error("\n❌ getAmountsOut FAILED — INIT_CODE_HASH patch did not work.");
    console.error("   Real hash (no 0x):", realHashHex);
    console.error(
      "   Open your UniswapV2Library.sol, find the hardcoded hex hash,\n" +
      "   and add it to KNOWN_PLACEHOLDERS in this deploy script.\n" +
      "   Then recompile (npx hardhat compile) and re-run."
    );
    process.exit(1);
  }

  /* ============================================================
     12. Wire MMM Token
  ============================================================ */
  await (await mmm.setPair(PAIR_ADDR)).wait();
  await (await mmm.setRouter(ROUTER_ADDR)).wait();
  await (await mmm.setTaxVaultOnce(TAXVAULT_ADDR)).wait();
  await (await mmm.setRewardVaultOnce(REWARDVAULT_ADDR)).wait();
  console.log("MMM wired (pair, router, taxVault, rewardVault).");

  /* ============================================================
     13. Tax Exemptions
  ============================================================ */
  await (await mmm.setTaxExempt(deployer.address,    true)).wait();
  await (await mmm.setTaxExempt(TAXVAULT_ADDR,       true)).wait();
  await (await mmm.setTaxExempt(ROUTER_ADDR,         true)).wait();
  await (await mmm.setTaxExempt(REWARDVAULT_ADDR,    true)).wait();
  console.log("Tax exemptions configured.");

  /* ============================================================
     14. Wire TaxVault
  ============================================================ */
  await (await taxVault.setRouter(ROUTER_ADDR)).wait();
  await (await taxVault.approveRouter()).wait();
  await (await taxVault.wireOnce(
    REWARDVAULT_ADDR,
    MARKETINGVAULT_ADDR,
    TEAMVESTINGVAULT_ADDR
  )).wait();
  console.log("TaxVault wired.");

  /* ============================================================
     15. Wire RewardVault
  ============================================================ */
  await (await rewardVault.setBoostNFT(BOOSTNFT_ADDR)).wait();
  console.log("RewardVault: BoostNFT set.");

  await (await rewardVault.addExcludedRewardAddress(PAIR_ADDR)).wait();
  await (await rewardVault.addExcludedRewardAddress(TAXVAULT_ADDR)).wait();
  await (await rewardVault.addExcludedRewardAddress(deployer.address)).wait();
  console.log("RewardVault: exclusions set.");

  await (await rewardVault.transferOwnership(TAXVAULT_ADDR)).wait();
  console.log("RewardVault: ownership transferred to TaxVault.");

  /* ============================================================
     16. Add Initial Liquidity – Manual seed (bypasses router)
         Monad testnet gas estimator is broken for addLiquidityETH
  ============================================================ */
  const amountMMM = ethers.parseUnits("2000", 18);
  const amountETH = ethers.parseEther("2");

  const pair = await ethers.getContractAt("UniswapV2Pair", PAIR_ADDR);

  await (await mmm.transfer(PAIR_ADDR, amountMMM)).wait();

  await (await weth.deposit({ value: amountETH })).wait();
  await (await weth.transfer(PAIR_ADDR, amountETH)).wait();

  await (await pair.mint(deployer.address, { gasLimit: 300000 })).wait();
  console.log("Liquidity seeded: 10000 MMM + 10 WMON.");

  /* ============================================================
     17. Launch Token
  ============================================================ */
  await (await mmm.launch()).wait();
  console.log("Token launched.");

  /* ============================================================
     SUMMARY
  ============================================================ */
  console.log("\n================================================");
  console.log("DEPLOY COMPLETE");
  console.log("================================================");
  console.log("TESTNET_WMON:             ", WETH_ADDR);
  console.log("TESTNET_USDC:             ", USDC_ADDR);
  console.log("TESTNET_FACTORY:          ", FACTORY_ADDR);
  console.log("TESTNET_ROUTER:           ", ROUTER_ADDR);
  console.log("TESTNET_MMM:              ", MMM_ADDR);
  console.log("TESTNET_PAIR:             ", PAIR_ADDR);
  console.log("TESTNET_TAX_VAULT:        ", TAXVAULT_ADDR);
  console.log("TESTNET_REWARD_VAULT:     ", REWARDVAULT_ADDR);
  console.log("TESTNET_MARKETING_VAULT:  ", MARKETINGVAULT_ADDR);
  console.log("TESTNET_TEAM_VAULT:       ", TEAMVESTINGVAULT_ADDR);
  console.log("TESTNET_BOOST_NFT:        ", BOOSTNFT_ADDR);
  console.log("INIT_CODE_HASH:           ", realInitCodeHash);
  console.log("================================================");
  console.log("\n⚠️  POST-DEPLOY CHECKLIST:");
  console.log("1. Update your .env with all addresses above.");
  console.log("2. Set TESTNET_MULTISIG_2 and TESTNET_MULTISIG_3 in .env");
  console.log("   for proper 2-of-3 multisig on Marketing/TeamVesting vaults.");
  console.log("3. RewardVault ownership transferred to TaxVault.");
  console.log("================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});