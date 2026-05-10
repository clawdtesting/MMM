// test/fixtures/protocol.fixture.js
const { ethers } = require("hardhat");

async function deployFixture() {
  const [owner, user1, user2, user3] = await ethers.getSigners();

  /* -----------------------------------------
     1. Deploy Mock Tokens
  ----------------------------------------- */

  const MockERC20 = await ethers.getContractFactory("MockERC20");

  const USDC = await MockERC20.deploy("USD Coin", "USDC", 6, owner.address);
  await USDC.waitForDeployment();

  const WMON = await MockERC20.deploy("Wrapped MON", "WMON", 18, owner.address);
  await WMON.waitForDeployment();

  /* -----------------------------------------
     2. Deploy MMM (MATCH YOUR REAL CONSTRUCTOR)
  ----------------------------------------- */

  const MMMToken = await ethers.getContractFactory("MMMToken");

  // ⚠️ MODIFY THIS LINE to match your real constructor
  const MMM = await MMMToken.deploy(
    owner.address,
    ethers.ZeroAddress   // usdcAddress (not used in constructor)
  );

  await MMM.waitForDeployment();

  /* -----------------------------------------
     3. Deploy Router
  ----------------------------------------- */

  const MockRouter = await ethers.getContractFactory("MockRouter");

  const router = await MockRouter.deploy(
    await MMM.getAddress(),
    await WMON.getAddress(),
    await USDC.getAddress()
  );

  await router.waitForDeployment();

  /* -----------------------------------------
     4. Deploy Vaults
  ----------------------------------------- */

  const RewardVault = await ethers.getContractFactory("RewardVault");

  const rewardVault = await RewardVault.deploy(
    await MMM.getAddress(),
    60, // 1 minute min hold time for testing
    60, // 1 minute claim cooldown for testing
    ethers.parseUnits("100", 18), // 100 tokens minimum balance for testing
    owner.address
  );

  await rewardVault.waitForDeployment();

  const SwapVault = await ethers.getContractFactory("SwapVault");
  const swapVault = await SwapVault.deploy(await MMM.getAddress(), owner.address);
  await swapVault.waitForDeployment();

  const MarketingVault = await ethers.getContractFactory("MarketingVault");
  const marketingVault = await MarketingVault.deploy(
    await USDC.getAddress(),
    [owner.address, user1.address, user2.address]
  );
  await marketingVault.waitForDeployment();

  const TeamVestingVault = await ethers.getContractFactory("TeamVestingVault");
  const teamVestingVault = await TeamVestingVault.deploy(
    await USDC.getAddress(),
    [owner.address, user1.address, user2.address]
  );
  await teamVestingVault.waitForDeployment();

  /* -----------------------------------------
     5. Deploy TaxVault (MATCH REAL SIGNATURE)
  ----------------------------------------- */
  const TaxVault = await ethers.getContractFactory("TaxVault");
  const taxVault = await TaxVault.deploy(
    await MMM.getAddress(),
    await USDC.getAddress(),
    await WMON.getAddress(),
    owner.address
  );

  await taxVault.waitForDeployment();

  /* -----------------------------------------
     6. Wire Protocol
  ----------------------------------------- */

  await taxVault.setRouter(await router.getAddress());
  await taxVault.approveRouter();
  await taxVault.setProcessingEnabled(true);
  await taxVault.wireOnce(
    await rewardVault.getAddress(),
    await marketingVault.getAddress(),
    await teamVestingVault.getAddress()
  );

  await MMM.setTaxVault(await taxVault.getAddress());
  await MMM.setTaxExempt(await taxVault.getAddress(), true);
  await MMM.setTaxExempt(await router.getAddress(), true);
  await MMM.setTaxExempt(await rewardVault.getAddress(), true);
  await MMM.setTaxExempt(await swapVault.getAddress(), true);

  return {
    owner,
    user1,
    user2,
    user3,
    MMM,
    USDC,
    WMON,
    router,
    taxVault,
    rewardVault,
    swapVault,
    marketingVault,
    teamVestingVault
  };
}

module.exports = { deployFixture };