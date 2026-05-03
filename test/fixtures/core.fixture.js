const { ethers } = require("hardhat");

async function coreFixture() {
  // `pair` is a dedicated signer used as the AMM pair address so that
  // transfers between owner/user1/user2 are not misclassified as buy/sell
  // and thus do not get taxed in unit tests that expect tax-free movement.
  const [owner, user1, user2, pair] = await ethers.getSigners();

  /* -----------------------------------------
     1. Deploy MMM
  ----------------------------------------- */

  const MMMToken = await ethers.getContractFactory("MMMToken");

  const initialSupply = ethers.parseUnits("1000000", 18);

  const mmm = await MMMToken.deploy(
    "Monad Money Machine",
    "MMM",
    initialSupply,
    owner.address
  );

  await mmm.waitForDeployment();

  /* -----------------------------------------
     2. Deploy Mock USDC + WMON
  ----------------------------------------- */

  const MockERC20 = await ethers.getContractFactory("MockERC20");

  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6, owner.address);
  await usdc.waitForDeployment();

  const wmon = await MockERC20.deploy("Wrapped MON", "WMON", 18, owner.address);
  await wmon.waitForDeployment();

  /* -----------------------------------------
     3. Deploy MockRouter
  ----------------------------------------- */

  const MockRouter = await ethers.getContractFactory("MockRouter");

  const mockRouter = await MockRouter.deploy(
    await mmm.getAddress(),
    await wmon.getAddress(),
    await usdc.getAddress()
  );

  await mockRouter.waitForDeployment();

  // Allow router to mint USDC + WMON
  await usdc.connect(owner).transferOwnership(await mockRouter.getAddress());
  await wmon.connect(owner).transferOwnership(await mockRouter.getAddress());


  /* -----------------------------------------
     4. Deploy RewardVault
  ----------------------------------------- */

  const RewardVault = await ethers.getContractFactory("RewardVault");

  const minHoldTime = 3600;
  const cooldown    = 600;
  const minBalance  = ethers.parseUnits("100", 18);

  const rewardVault = await RewardVault.deploy(
    await mmm.getAddress(),
    minHoldTime,
    cooldown,
    minBalance,
    owner.address
  );

  await rewardVault.waitForDeployment();

  await mmm.connect(owner).setTaxExempt(
    await rewardVault.getAddress(),
    true
  );

  /* -----------------------------------------
     5. Deploy TaxVault
  ----------------------------------------- */

  const TaxVault = await ethers.getContractFactory("TaxVault");

  const taxVault = await TaxVault.deploy(
    await mmm.getAddress(),
    await usdc.getAddress(),
    await wmon.getAddress(),
    owner.address
  );

  await taxVault.waitForDeployment();

  await mmm.connect(owner).setTaxExempt(
    await taxVault.getAddress(),
    true
  );


  // Transfer RewardVault ownership to TaxVault
  // Wire the reward sync hook BEFORE we transfer ownership of the
  // RewardVault to TaxVault. Once wired, every MMMToken._update will
  // call preTransferHook + postTransferHook on RewardVault, keeping
  // rewardDebt in sync with each user's balance (fixes issues #5/#7).
  await mmm.connect(owner).setRewardVaultOnce(
    await rewardVault.getAddress()
  );

  await rewardVault.connect(owner).transferOwnership(
      await taxVault.getAddress()
    );


  /* -----------------------------------------
     6. Configure MMM for Tax
  ----------------------------------------- */

  await mmm.connect(owner).setTaxVaultOnce(
    await taxVault.getAddress()
  );

  await mmm.connect(owner).setPair(pair.address);
  await mmm.connect(owner).setTaxExempt(owner.address, false);
  await mmm.connect(owner).launch();

  /* -----------------------------------------
     7. Deploy Marketing + Team Vaults
  ----------------------------------------- */

  const MarketingVault = await ethers.getContractFactory("MarketingVault");
  const TeamVestingVault = await ethers.getContractFactory("TeamVestingVault");

  const owners = [owner.address, user1.address, user2.address];

  const marketingVault = await MarketingVault.deploy(
    await usdc.getAddress(),
    owners
  );
  await marketingVault.waitForDeployment();

  const teamVestingVault = await TeamVestingVault.deploy(
    await usdc.getAddress(),
    owners
  );
  await teamVestingVault.waitForDeployment();

  /* -----------------------------------------
     8. Wire TaxVault
  ----------------------------------------- */

  await taxVault.connect(owner).wireOnce(
    await rewardVault.getAddress(),
    await marketingVault.getAddress(),
    await teamVestingVault.getAddress()
  );

  /* -----------------------------------------
     9. Configure Router
  ----------------------------------------- */

  await taxVault.connect(owner).setRouter(await mockRouter.getAddress());
  await taxVault.connect(owner).approveRouter();

  /* -----------------------------------------
     RETURN
  ----------------------------------------- */

  return {
    owner,
    user1,
    user2,
    pair,
    mmm,
    usdc,
    wmon,
    rewardVault,
    taxVault,
    marketingVault,
    teamVestingVault,
    mockRouter,
    minHoldTime,
    cooldown,
    minBalance
  };
}

module.exports = { coreFixture };
