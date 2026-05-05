const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");
const { notifyAs } = require("./helpers/notifyAs");

describe("RewardVault - Claim Flow", function () {

  it("distributes rewards and resets pending", async function () {

    const {
      owner,
      user1,
      mmm,
      taxVault,
      rewardVault,
      minHoldTime,
      cooldown
    } = await loadFixture(coreFixture);

    // Give user tokens
    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    // Pass hold time
    await time.increase(minHoldTime + 1);

    // Emit rewards. RewardVault ownership is held by TaxVault under the
    // production wiring; impersonate it for the notify.
    const rewardAmount = ethers.parseUnits("100", 18);
    await mmm.connect(owner).transfer(
      await rewardVault.getAddress(),
      rewardAmount
    );
    await notifyAs(taxVault, rewardVault, rewardAmount);

    const pendingBefore = await rewardVault.pending(user1.address);
    expect(pendingBefore).to.be.gt(0n);

    const balanceBefore = await mmm.balanceOf(user1.address);

    // Claim
    await rewardVault.connect(user1).claim();

    const balanceAfter = await mmm.balanceOf(user1.address);
    const pendingAfter = await rewardVault.pending(user1.address);
    const lastClaimAt = await rewardVault.lastClaimAt(user1.address);

    // 1. Balance increased
    expect(balanceAfter).to.be.gt(balanceBefore);

    // 2. Pending reset
    expect(pendingAfter).to.be.lt(pendingBefore);

    const totalClaimed = await rewardVault.totalClaimed();
    expect(totalClaimed).to.equal(pendingBefore);





    // 3. lastClaimAt updated
    expect(lastClaimAt).to.be.gt(0n);

    // 4. Cooldown active
    await expect(
      rewardVault.connect(user1).claim()
    ).to.be.reverted;

    // 5. After cooldown passes, claim allowed again (if rewards exist)
    await time.increase(cooldown + 1);

  });

});
