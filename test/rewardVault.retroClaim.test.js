// Regression test for issues.txt #5 (Reward Debt Desynchronization) and
// #7 (Retroactive Reward Claiming). Without the MMMToken -> RewardVault
// sync hook, a brand-new buyer can claim against the entire history of
// accRewardPerToken. With the hook in place, their rewardDebt is set to
// (newBalance * accRewardPerToken) the moment they receive tokens, so
// pending() for them is zero immediately after the buy.
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, network } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

async function impersonate(addr) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [
    addr,
    "0x56BC75E2D63100000", // 100 ETH
  ]);
  return ethers.getSigner(addr);
}

describe("RewardVault - Retroactive Claim Defence (issues #5/#7)", function () {

  it("new holder receives ZERO retroactive rewards from prior notifies", async function () {
    const {
      owner,
      user1,
      user2,
      mmm,
      taxVault,
      rewardVault,
      minHoldTime,
    } = await loadFixture(coreFixture);

    // ---- Step 1: user1 enters EARLY ----
    const heldAmount = ethers.parseUnits("1000", 18);
    await mmm.connect(owner).transfer(user1.address, heldAmount);

    // ---- Step 2: protocol distributes a meaningful reward batch ----
    // RewardVault.notifyRewardAmount is onlyOwner; production wiring puts
    // ownership on TaxVault, so we impersonate TaxVault for the call.
    const taxVaultAddr = await taxVault.getAddress();
    const rewardVaultAddr = await rewardVault.getAddress();
    const reward = ethers.parseUnits("500", 18);

    await mmm.connect(owner).transfer(rewardVaultAddr, reward);
    const taxSigner = await impersonate(taxVaultAddr);
    await rewardVault.connect(taxSigner).notifyRewardAmount(reward);

    // user1's pending must be > 0 because they were in BEFORE the notify.
    const user1Pending = await rewardVault.pending(user1.address);
    expect(user1Pending).to.be.gt(0n);

    // ---- Step 3: user2 enters AFTER the notify ----
    await mmm.connect(owner).transfer(user2.address, heldAmount);

    // ---- ASSERTION: user2 must NOT inherit history. ----
    // Without the hook this would equal user1Pending. With the hook the
    // hook in postTransferHook sets rewardDebt[user2] to balance*acc, so
    // pending() returns 0.
    const user2Pending = await rewardVault.pending(user2.address);
    expect(user2Pending).to.equal(0n);

    // ---- Step 4: a SECOND notify hits while both hold equal balances ----
    const reward2 = ethers.parseUnits("200", 18);
    await mmm.connect(owner).transfer(rewardVaultAddr, reward2);
    await rewardVault.connect(taxSigner).notifyRewardAmount(reward2);

    // Both should have accrued the SAME amount from this notify since
    // they hold the same balance going forward.
    const user1After = await rewardVault.pending(user1.address);
    const user2After = await rewardVault.pending(user2.address);

    // user1 keeps their pre-existing pending plus a new slice; user2 only
    // gets the new slice. So user1 must be strictly greater than user2,
    // and the difference should be ~equal to user1's pre-step3 balance.
    expect(user1After).to.be.gt(user2After);
    expect(user2After).to.be.gt(0n);

    const newSliceForUser2 = user2After;
    const expectedUser1 = user1Pending + newSliceForUser2;
    // Allow 1 wei rounding from integer division.
    const delta = user1After > expectedUser1
      ? user1After - expectedUser1
      : expectedUser1 - user1After;
    expect(delta).to.be.lte(1n);

    await network.provider.send("hardhat_stopImpersonatingAccount", [taxVaultAddr]);
  });

  it("crystallised rewards survive a partial transfer out", async function () {
    const {
      owner,
      user1,
      user2,
      mmm,
      taxVault,
      rewardVault,
    } = await loadFixture(coreFixture);

    const initial = ethers.parseUnits("1000", 18);
    await mmm.connect(owner).transfer(user1.address, initial);

    const taxVaultAddr = await taxVault.getAddress();
    const rewardVaultAddr = await rewardVault.getAddress();
    const taxSigner = await impersonate(taxVaultAddr);

    const reward = ethers.parseUnits("100", 18);
    await mmm.connect(owner).transfer(rewardVaultAddr, reward);
    await rewardVault.connect(taxSigner).notifyRewardAmount(reward);

    const pendingBefore = await rewardVault.pending(user1.address);
    expect(pendingBefore).to.be.gt(0n);

    // user1 ships HALF their balance to a fresh wallet. The pre-transfer
    // hook crystallises pendingBefore into claimable[user1], so pending
    // must NOT shrink despite the smaller balance.
    const half = initial / 2n;
    await mmm.connect(user1).transfer(user2.address, half);

    const pendingAfter = await rewardVault.pending(user1.address);
    expect(pendingAfter).to.equal(pendingBefore);

    // user2 still must not have retroactive entitlement.
    const user2Pending = await rewardVault.pending(user2.address);
    expect(user2Pending).to.equal(0n);

    await network.provider.send("hardhat_stopImpersonatingAccount", [taxVaultAddr]);
  });

  it("hook is rejected when called by anyone other than MMMToken", async function () {
    const { user1, rewardVault } = await loadFixture(coreFixture);

    await expect(
      rewardVault.connect(user1).preTransferHook(user1.address, user1.address)
    ).to.be.revertedWithCustomError(rewardVault, "OnlyToken");

    await expect(
      rewardVault.connect(user1).postTransferHook(user1.address, user1.address)
    ).to.be.revertedWithCustomError(rewardVault, "OnlyToken");
  });

});
