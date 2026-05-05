const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { coreFixture } = require("../fixtures/core.fixture");

describe("Integration — full reward flow via taxVault.process", function () {

  it("buy → process → hold → claim", async function () {
    const { mmm, usdc, taxVault, rewardVault, user1 } =
      await loadFixture(coreFixture);

    // Step 1 — user receives MMM (simulates buy via the AMM, or
    // an OTC transfer; tax-free since neither side is the pair).
    const buyAmount = ethers.parseUnits("1000", 18);
    await mmm.transfer(user1.address, buyAmount);

    // Step 2 — accumulate MMM in TaxVault and run processing.
    const taxAmount = ethers.parseUnits("10000", 18);
    await mmm.transfer(await taxVault.getAddress(), taxAmount);

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const rewardBalBefore = await mmm.balanceOf(await rewardVault.getAddress());
    await taxVault.process(taxAmount, 0, deadline);

    expect(await mmm.balanceOf(await rewardVault.getAddress()))
      .to.be.gt(rewardBalBefore);

    // Step 3 — user accrued rewards.
    expect(await rewardVault.pending(user1.address)).to.be.gt(0n);

    // Step 4 — wait out the hold period and claim.
    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(minHoldTime);

    const balBefore = await mmm.balanceOf(user1.address);
    const usdcBefore = await usdc.balanceOf(user1.address);
    await rewardVault.connect(user1).claim();
    const balAfter = await mmm.balanceOf(user1.address);
    const usdcAfter = await usdc.balanceOf(user1.address);

    expect(balAfter).to.be.gt(balBefore);
    // The reward payout is in MMM; USDC goes to marketing/team vaults,
    // not directly to claiming users.
    expect(usdcAfter).to.equal(usdcBefore);

    // Step 5 — cooldown blocks immediate re-claim.
    await expect(rewardVault.connect(user1).claim()).to.be.reverted;
  });

  it("buy → sell-all → re-buy resets the hold timer", async function () {
    const { mmm, taxVault, rewardVault, owner, user1 } =
      await loadFixture(coreFixture);

    const buyAmount = ethers.parseUnits("500", 18);
    await mmm.transfer(user1.address, buyAmount);
    const lnz1 = await mmm.lastNonZeroAt(user1.address);

    // Sell everything back to owner (no AMM tax — neither side is pair).
    await mmm.connect(user1).transfer(
      owner.address,
      await mmm.balanceOf(user1.address)
    );
    expect(await mmm.balanceOf(user1.address)).to.equal(0n);
    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(0n);

    // Re-buy.
    await time.increase(100);
    await mmm.transfer(user1.address, buyAmount);
    const lnz2 = await mmm.lastNonZeroAt(user1.address);
    expect(lnz2).to.be.gt(lnz1);

    // Create a fresh emission.
    const taxAmount = ethers.parseUnits("10000", 18);
    await mmm.transfer(await taxVault.getAddress(), taxAmount);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);

    // Hold not yet met — claim must revert.
    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(BigInt(minHoldTime) - 200n);
    await expect(rewardVault.connect(user1).claim()).to.be.reverted;

    // Wait out the rest, then claim.
    await time.increase(300n);
    await rewardVault.connect(user1).claim();
  });

  it("partial sell preserves hold eligibility", async function () {
    // Documented design: partial sell keeps lastNonZeroAt for the
    // remaining balance. After hold elapses, the user can still claim
    // their share (proportional to the reduced position).
    const { mmm, taxVault, rewardVault, owner, user1 } =
      await loadFixture(coreFixture);

    const buyAmount = ethers.parseUnits("1000", 18);
    await mmm.transfer(user1.address, buyAmount);
    const lnzBefore = await mmm.lastNonZeroAt(user1.address);

    const balance = await mmm.balanceOf(user1.address);
    await mmm.connect(user1).transfer(owner.address, balance / 2n);

    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(lnzBefore);

    const taxAmount = ethers.parseUnits("10000", 18);
    await mmm.transfer(await taxVault.getAddress(), taxAmount);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);

    expect(await rewardVault.pending(user1.address)).to.be.gt(0n);

    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(minHoldTime);

    const balBefore = await mmm.balanceOf(user1.address);
    await rewardVault.connect(user1).claim();
    expect(await mmm.balanceOf(user1.address)).to.be.gt(balBefore);
  });

  it("multiple users compete for rewards proportional to balance", async function () {
    const { mmm, taxVault, rewardVault, user1, user2 } =
      await loadFixture(coreFixture);

    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));
    await mmm.transfer(user2.address, ethers.parseUnits("2000", 18));

    const taxAmount = ethers.parseUnits("10000", 18);
    await mmm.transfer(await taxVault.getAddress(), taxAmount);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);

    const p1 = await rewardVault.pending(user1.address);
    const p2 = await rewardVault.pending(user2.address);
    expect(p1).to.be.gt(0n);
    expect(p2).to.be.gt(0n);

    // user2 has 2x balance → ~2x pending.
    const ratio = (p2 * 100n) / p1;
    expect(ratio).to.be.closeTo(200n, 5n);

    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(minHoldTime);

    await rewardVault.connect(user1).claim();
    await rewardVault.connect(user2).claim();
  });

});
