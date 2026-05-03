const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

// Confirms the balance-weighted lastNonZeroAt update neutralises dust
// priming as a hold-time bypass: receiving a tiny amount and waiting out
// the hold window does NOT mature a wallet for a later large inbound
// transfer.

describe("Security - Dust priming cannot bypass hold time", function () {

  it("large inflow into a dust-primed wallet shifts lastNonZeroAt forward", async function () {
    const { owner, user1, mmm, minHoldTime } = await loadFixture(coreFixture);

    // 1) Prime user1 with a single wei.
    await mmm.transfer(user1.address, 1n);
    const lnzAfterDust = await mmm.lastNonZeroAt(user1.address);
    expect(lnzAfterDust).to.be.gt(0n);

    // 2) Wait the full hold period — wallet is "matured" under the old model.
    await time.increase(minHoldTime + 1);

    const tBeforeBigBuy = BigInt(await time.latest());

    // 3) Receive a large inbound transfer.
    const big = ethers.parseUnits("10000", 18);
    await mmm.transfer(user1.address, big);

    const lnzAfterBig = await mmm.lastNonZeroAt(user1.address);

    // The new lastNonZeroAt should be essentially the timestamp of the
    // big transfer — the 1-wei prior balance contributes negligibly to
    // the weighted average ((1*old + big*now) / (1+big) ≈ now).
    // Allow 2-second slack for block-timestamp variance.
    expect(lnzAfterBig).to.be.gte(tBeforeBigBuy);
    expect(lnzAfterBig).to.be.closeTo(BigInt(await time.latest()), 2n);
  });

  it("a legitimate top-up shifts lastNonZeroAt only partway forward", async function () {
    const { owner, user1, mmm } = await loadFixture(coreFixture);

    // user1 holds a real position.
    const initial = ethers.parseUnits("5000", 18);
    await mmm.transfer(user1.address, initial);
    const lnzInitial = await mmm.lastNonZeroAt(user1.address);

    // Wait some time, then top up by an equal amount.
    await time.increase(1000);
    await mmm.transfer(user1.address, initial);

    const tNow = BigInt(await time.latest());
    const lnzAfter = await mmm.lastNonZeroAt(user1.address);

    // Equal weights → the new lnz should sit roughly halfway between the
    // original lnz and `now`.
    const expected = (lnzInitial + tNow) / 2n;
    expect(lnzAfter).to.be.closeTo(expected, 2n);
  });

  it("partial sell preserves the existing lastNonZeroAt", async function () {
    // Re-affirms the production semantics that the security fix must not
    // accidentally break.
    const { owner, user1, mmm } = await loadFixture(coreFixture);

    const amount = ethers.parseUnits("1000", 18);
    await mmm.transfer(user1.address, amount);
    const lnzBefore = await mmm.lastNonZeroAt(user1.address);

    await mmm.connect(user1).transfer(owner.address, amount / 2n);

    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(lnzBefore);
  });

  it("full exit clears lastNonZeroAt; re-entry resets to current time", async function () {
    const { owner, user1, mmm } = await loadFixture(coreFixture);

    const amount = ethers.parseUnits("1000", 18);
    await mmm.transfer(user1.address, amount);

    await mmm.connect(user1).transfer(owner.address, amount);
    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(0n);

    await time.increase(100);
    await mmm.transfer(user1.address, amount);

    const tNow = BigInt(await time.latest());
    expect(await mmm.lastNonZeroAt(user1.address)).to.be.closeTo(tNow, 2n);
  });

});
