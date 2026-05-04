const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { coreFixture } = require("../fixtures/core.fixture");

// taxVault is the production owner of rewardVault; impersonate it for
// direct notifyRewardAmount calls. Production flow goes through
// taxVault.process(), which is exercised separately.
async function notifyAs(taxVault, rewardVault, amount) {
  const addr = await taxVault.getAddress();
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  const signer = await ethers.getSigner(addr);
  await rewardVault.connect(signer).notifyRewardAmount(amount);
  await network.provider.send("hardhat_stopImpersonatingAccount", [addr]);
}

describe("RewardVault — unit (claim guard rails)", function () {

  it("reverts claim when balance is zero", async function () {
    const { rewardVault, user1 } = await loadFixture(coreFixture);
    await expect(rewardVault.connect(user1).claim()).to.be.reverted;
  });

  it("reverts claim when balance is below minBalance", async function () {
    const { mmm, taxVault, rewardVault, user1, minBalance, minHoldTime } =
      await loadFixture(coreFixture);

    // Dust-only position
    const dust = minBalance > 1n ? minBalance - 1n : 1n;
    await mmm.transfer(user1.address, dust);

    // Distribute rewards
    const reward = ethers.parseUnits("400", 18);
    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);

    await time.increase(minHoldTime + 1);

    await expect(rewardVault.connect(user1).claim()).to.be.reverted;
  });

  it("reverts claim when no rewards are pending", async function () {
    const { mmm, rewardVault, user1, minHoldTime } = await loadFixture(coreFixture);

    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));
    await time.increase(minHoldTime + 1);

    await expect(rewardVault.connect(user1).claim()).to.be.reverted;
  });

  it("enforces cooldown between claims", async function () {
    const { mmm, taxVault, rewardVault, user1, minHoldTime, cooldown } =
      await loadFixture(coreFixture);

    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    // First emission and claim.
    const reward = ethers.parseUnits("400", 18);
    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);
    await time.increase(minHoldTime + 1);
    await rewardVault.connect(user1).claim();

    // Second emission, immediate re-claim must fail (cooldown).
    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);
    await expect(rewardVault.connect(user1).claim()).to.be.reverted;

    // After cooldown elapses the claim succeeds.
    await time.increase(cooldown + 1);
    await expect(rewardVault.connect(user1).claim()).to.not.be.reverted;
  });

});

describe("RewardVault — unit (multi-user and accumulation)", function () {

  it("supports multiple users claiming in sequence", async function () {
    const { mmm, taxVault, rewardVault, user1, user2, minHoldTime } =
      await loadFixture(coreFixture);

    const seed = ethers.parseUnits("1000", 18);
    await mmm.transfer(user1.address, seed);
    await mmm.transfer(user2.address, seed);

    const reward = ethers.parseUnits("400", 18);
    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);

    await time.increase(minHoldTime + 1);

    await rewardVault.connect(user1).claim();
    await rewardVault.connect(user2).claim();

    expect(await mmm.balanceOf(user1.address)).to.be.gt(seed);
    expect(await mmm.balanceOf(user2.address)).to.be.gt(seed);
  });

  it("accumulates pending across multiple notifies", async function () {
    const { mmm, taxVault, rewardVault, user1 } = await loadFixture(coreFixture);

    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    const reward = ethers.parseUnits("100", 18);

    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);
    const afterFirst = await rewardVault.pending(user1.address);

    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);
    const afterSecond = await rewardVault.pending(user1.address);

    expect(afterSecond).to.be.gt(afterFirst);
  });

});

describe("RewardVault — unit (excluded supply)", function () {

  it("excluded addresses do not accrue rewards", async function () {
    const { mmm, taxVault, rewardVault, user1 } = await loadFixture(coreFixture);

    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    const reward = ethers.parseUnits("400", 18);
    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);

    // RewardVault excludes itself; pending against its own address must be 0.
    expect(await rewardVault.pending(await rewardVault.getAddress())).to.equal(0n);
    // taxVault is excluded by the fixture wiring.
    expect(await rewardVault.pending(await taxVault.getAddress())).to.equal(0n);
  });

});

describe("RewardVault — unit (notify dust accumulation)", function () {

  it("carries the integer-division remainder forward across notifies", async function () {
    const { mmm, taxVault, rewardVault, user1 } = await loadFixture(coreFixture);

    // Park MMM at user1 so eligibleSupply is non-trivial.
    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    // Pick an amount that is unlikely to divide cleanly. The test only
    // asserts the remainder is tracked; exact values depend on
    // eligibleSupply, but the remainder must be < eligibleSupply and
    // strictly within bounds after each notify.
    const reward = ethers.parseUnits("123456789", 12);

    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);
    const r1 = await rewardVault.notifyRemainder();
    const denom1 = await rewardVault.eligibleSupply();
    expect(r1).to.be.lt(denom1);

    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);
    const r2 = await rewardVault.notifyRemainder();
    const denom2 = await rewardVault.eligibleSupply();
    expect(r2).to.be.lt(denom2);
  });

});
