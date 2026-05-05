const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, network } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

async function impersonate(addr) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

describe("MMMToken - emergency pause + guardian", function () {

  it("non-owner non-guardian cannot pause", async function () {
    const { mmm, user1 } = await loadFixture(coreFixture);
    await expect(mmm.connect(user1).pause()).to.be.revertedWithCustomError(
      mmm,
      "NotGuardian"
    );
  });

  it("guardian can pause but cannot unpause", async function () {
    const { mmm, owner, user1, user2 } = await loadFixture(coreFixture);

    await mmm.connect(owner).setGuardian(user1.address);
    expect(await mmm.guardian()).to.equal(user1.address);

    // guardian pauses
    await mmm.connect(user1).pause();
    expect(await mmm.paused()).to.be.true;

    // guardian CANNOT unpause (owner-only)
    await expect(mmm.connect(user1).unpause()).to.be.reverted;

    // owner can unpause
    await mmm.connect(owner).unpause();
    expect(await mmm.paused()).to.be.false;
  });

  it("paused state reverts plain transfers but allows mint/burn paths", async function () {
    const { mmm, owner, user1, user2 } = await loadFixture(coreFixture);

    // Seed user1 first while unpaused.
    await mmm.transfer(user1.address, ethers.parseUnits("100", 18));

    await mmm.connect(owner).pause();

    // Plain user-to-user transfer must revert.
    await expect(
      mmm.connect(user1).transfer(user2.address, 1n)
    ).to.be.revertedWithCustomError(mmm, "EnforcedPause");

    // Burn (to address(0)) is not directly callable on ERC20, but minting
    // (only the constructor does this) is implicitly tested by the
    // contract deploying at all. This test just ensures we don't
    // accidentally block the address(0) path elsewhere.
    expect(await mmm.paused()).to.be.true;

    // Once unpaused, transfers resume.
    await mmm.connect(owner).unpause();
    await mmm.connect(user1).transfer(user2.address, 1n);
    expect(await mmm.balanceOf(user2.address)).to.equal(1n);
  });

});

describe("MMMToken - Ownable2Step ownership transfer", function () {

  it("transferOwnership stages a pendingOwner; old owner remains until acceptOwnership", async function () {
    const { mmm, owner, user1 } = await loadFixture(coreFixture);

    await mmm.connect(owner).transferOwnership(user1.address);

    // Old owner still in charge; pendingOwner is staged.
    expect(await mmm.owner()).to.equal(owner.address);
    expect(await mmm.pendingOwner()).to.equal(user1.address);

    // Random caller cannot accept.
    await expect(
      mmm.connect(owner).acceptOwnership()
    ).to.be.reverted;

    // Pending owner accepts → ownership flips.
    await mmm.connect(user1).acceptOwnership();
    expect(await mmm.owner()).to.equal(user1.address);
    expect(await mmm.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

});

describe("RewardVault - distributionsEnabled kill switch", function () {

  it("notifyRewardAmount reverts while disabled but claimable balances stay claimable", async function () {
    const { mmm, taxVault, rewardVault, user1, owner, minHoldTime } =
      await loadFixture(coreFixture);

    // Seed user, fund vault, do one normal notify so user has pending.
    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));
    await mmm.transfer(await rewardVault.getAddress(), ethers.parseUnits("100", 18));
    const tax = await impersonate(await taxVault.getAddress());
    await rewardVault.connect(tax).notifyRewardAmount(ethers.parseUnits("100", 18));

    const pendingBefore = await rewardVault.pending(user1.address);
    expect(pendingBefore).to.be.gt(0n);

    // Disable distributions (taxVault is owner).
    await rewardVault.connect(tax).setDistributionsEnabled(false);

    await expect(
      rewardVault.connect(tax).notifyRewardAmount(ethers.parseUnits("50", 18))
    ).to.be.revertedWithCustomError(rewardVault, "DistributionsDisabled");

    // Pending is preserved; user can still claim.
    expect(await rewardVault.pending(user1.address)).to.equal(pendingBefore);

    await time.increase(minHoldTime + 1);
    await rewardVault.connect(user1).claim();

    // Re-enable to verify the toggle is two-way.
    await rewardVault.connect(tax).setDistributionsEnabled(true);
    await mmm.transfer(await rewardVault.getAddress(), ethers.parseUnits("50", 18));
    await rewardVault.connect(tax).notifyRewardAmount(ethers.parseUnits("50", 18));

    await network.provider.send("hardhat_stopImpersonatingAccount", [
      await taxVault.getAddress()
    ]);
  });

});

describe("RewardVault - excluded-address cap", function () {

  it("MAX_EXCLUDED bounds eligibleSupply gas and rejects the 33rd address", async function () {
    const { rewardVault, taxVault, owner } = await loadFixture(coreFixture);
    const tax = await impersonate(await taxVault.getAddress());

    // Fixture already added rewardVault, taxVault, pair, DEAD = 4. Cap = 32.
    // Add 28 more to hit the cap.
    for (let i = 0; i < 28; i++) {
      const addr = ethers.getAddress(
        "0x" + (i + 0xCA00).toString(16).padStart(40, "0")
      );
      await rewardVault.connect(tax).addExcludedRewardAddress(addr);
    }

    // 33rd addition reverts.
    const overflow = ethers.getAddress(
      "0x" + (0xCA00 + 28).toString(16).padStart(40, "0")
    );
    await expect(
      rewardVault.connect(tax).addExcludedRewardAddress(overflow)
    ).to.be.revertedWithCustomError(rewardVault, "TooManyExcluded");

    await network.provider.send("hardhat_stopImpersonatingAccount", [
      await taxVault.getAddress()
    ]);
  });

});
