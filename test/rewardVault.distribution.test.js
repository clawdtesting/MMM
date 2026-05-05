const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");
const { notifyAs } = require("./helpers/notifyAs");

describe("RewardVault - Deterministic Distribution", function () {

  it("increases pending after notifyRewardAmount", async function () {

    const {
      user1,
      mmm,
      taxVault,
      rewardVault,
      minHoldTime
    } = await loadFixture(coreFixture);

    // Give user tokens
    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    // Pass hold time
    await time.increase(minHoldTime + 1);

    const p0 = await rewardVault.pending(user1.address);

    // Simulate reward emission. RewardVault is owned by TaxVault under the
    // production wiring set up in coreFixture; impersonate it.
    const rewardAmount = ethers.parseUnits("100", 18);
    await mmm.transfer(await rewardVault.getAddress(), rewardAmount);
    await notifyAs(taxVault, rewardVault, rewardAmount);

    const p1 = await rewardVault.pending(user1.address);

    expect(p1).to.be.gt(p0);

  });

});
