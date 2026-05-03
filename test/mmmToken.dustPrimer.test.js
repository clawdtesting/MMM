// Regression test for issues.txt #6 — Dust wallet hold-time bypass.
//
// Before: lastNonZeroAt only moved on the 0 -> non-zero transition. An
// attacker could send 1 wei to a fresh wallet, wait minHoldTimeSec, then
// move 1M MMM in and instantly satisfy the hold check.
//
// After: every receipt nudges lastNonZeroAt with a balance-weighted
// average. A 1-wei primer followed by 1M MMM snaps the clock back to
// effectively `now`, so the attacker has to wait the FULL hold window
// against the real position size.
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, network } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

describe("MMMToken - Dust Primer Defence (issue #6)", function () {

  it("dust receipt followed by a real position resets the hold clock", async function () {
    const { owner, user1, mmm, minHoldTime } = await loadFixture(coreFixture);

    // 1) Prime the wallet with a single wei. Old code would set
    //    lastNonZeroAt = now and never advance it again.
    await mmm.connect(owner).transfer(user1.address, 1n);
    const lnzAfterDust = await mmm.lastNonZeroAt(user1.address);
    expect(lnzAfterDust).to.be.gt(0n);

    // 2) Wait the entire hold window so a naive implementation would
    //    consider this wallet "mature".
    await time.increase(minHoldTime + 1);

    // 3) Move a real position in.
    const realPosition = ethers.parseUnits("1000000", 18);
    await mmm.connect(owner).transfer(user1.address, realPosition);

    // 4) WAT must have advanced essentially to `now`. Because the
    //    primer was 1 wei out of (1 wei + 1M*1e18), the average is
    //    (1*oldTs + 1M*1e18*now) / (1M*1e18 + 1) ~= now.
    const lnzAfterReal = await mmm.lastNonZeroAt(user1.address);
    expect(lnzAfterReal).to.be.gt(lnzAfterDust);

    const blockTs = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    // Allow up to 2 seconds of drift for tiny weighting from the dust.
    expect(blockTs - lnzAfterReal).to.be.lte(2n);
  });

  it("blocks immediate claim after dust prime + real buy", async function () {
    const {
      owner,
      user1,
      mmm,
      taxVault,
      rewardVault,
      minHoldTime,
    } = await loadFixture(coreFixture);

    // Step 1: Dust prime.
    await mmm.connect(owner).transfer(user1.address, 1n);

    // Step 2: Wait long enough that a naive hold check would pass.
    await time.increase(minHoldTime + 1);

    // Step 3: Push the user above minBalance with a real buy.
    const realPosition = ethers.parseUnits("1000", 18);
    await mmm.connect(owner).transfer(user1.address, realPosition);

    // Step 4: Make rewards available so claim has a non-zero target.
    const taxVaultAddr = await taxVault.getAddress();
    const rewardVaultAddr = await rewardVault.getAddress();

    const reward = ethers.parseUnits("100", 18);
    await mmm.connect(owner).transfer(rewardVaultAddr, reward);

    await network.provider.send("hardhat_impersonateAccount", [taxVaultAddr]);
    await network.provider.send("hardhat_setBalance", [
      taxVaultAddr,
      "0x56BC75E2D63100000",
    ]);
    const taxSigner = await ethers.getSigner(taxVaultAddr);
    await rewardVault.connect(taxSigner).notifyRewardAmount(reward);
    await network.provider.send("hardhat_stopImpersonatingAccount", [taxVaultAddr]);

    // Step 5: Claim must revert — the WAT push from the real buy means
    // the hold timer has effectively just started.
    await expect(
      rewardVault.connect(user1).claim()
    ).to.be.revertedWithCustomError(rewardVault, "HoldTimeNotMet");

    // Step 6: After the FULL hold window from the real buy, claim works.
    await time.increase(minHoldTime + 1);
    await rewardVault.connect(user1).claim();
  });

  it("tiny additional receipts barely shift the timestamp for an existing holder", async function () {
    const { owner, user1, mmm } = await loadFixture(coreFixture);

    // Big initial position.
    await mmm.connect(owner).transfer(user1.address, ethers.parseUnits("1000000", 18));
    const t0 = await mmm.lastNonZeroAt(user1.address);

    // Wait a meaningful chunk of time.
    await time.increase(10_000);

    // 1 wei top-up — should NOT meaningfully shift the timestamp.
    await mmm.connect(owner).transfer(user1.address, 1n);
    const t1 = await mmm.lastNonZeroAt(user1.address);

    // Drift should be effectively zero (rounded to 0 by integer division
    // because 1 wei is negligible vs 1M * 1e18 wei).
    expect(t1).to.equal(t0);
  });

  it("partial sell still preserves hold-time eligibility", async function () {
    const { owner, user1, mmm } = await loadFixture(coreFixture);

    const amount = ethers.parseUnits("1000", 18);
    await mmm.connect(owner).transfer(user1.address, amount);
    const before = await mmm.lastNonZeroAt(user1.address);

    // Send half back. Sender-side hook only resets on full exit.
    await mmm.connect(user1).transfer(owner.address, amount / 2n);

    const after = await mmm.lastNonZeroAt(user1.address);
    expect(after).to.equal(before);
  });

  it("full exit + re-entry resets the clock to the new entry time", async function () {
    const { owner, user1, mmm } = await loadFixture(coreFixture);

    const amount = ethers.parseUnits("1000", 18);
    await mmm.connect(owner).transfer(user1.address, amount);
    const firstEntry = await mmm.lastNonZeroAt(user1.address);

    // Full exit.
    await mmm.connect(user1).transfer(owner.address, amount);
    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(0n);

    // Time gap.
    await time.increase(500);

    // Re-entry from zero.
    await mmm.connect(owner).transfer(user1.address, amount);
    const secondEntry = await mmm.lastNonZeroAt(user1.address);

    expect(secondEntry).to.be.gt(firstEntry);
  });

});
