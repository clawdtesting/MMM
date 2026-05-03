const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, network } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

// Notify rewards as taxVault (the production owner of rewardVault).
async function notifyAs(taxVault, rewardVault, amount) {
  const addr = await taxVault.getAddress();
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  const signer = await ethers.getSigner(addr);
  await rewardVault.connect(signer).notifyRewardAmount(amount);
  await network.provider.send("hardhat_stopImpersonatingAccount", [addr]);
}

describe("Security - No retroactive reward claiming", function () {

  it("a new holder receiving tokens AFTER notify gets 0 pending", async function () {
    const { owner, user1, user2, mmm, taxVault, rewardVault } =
      await loadFixture(coreFixture);

    // Existing holder so eligibleSupply > 0 and notify can succeed.
    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    // Distribute rewards BEFORE user2 ever holds tokens.
    const reward = ethers.parseUnits("400", 18);
    await mmm.transfer(await rewardVault.getAddress(), reward);
    await notifyAs(taxVault, rewardVault, reward);

    // user2 buys in AFTER the notify.
    await mmm.transfer(user2.address, ethers.parseUnits("1000", 18));

    // user2 must not be able to claim accRewardPerToken * balance retroactively.
    expect(await rewardVault.pending(user2.address)).to.equal(0n);
    expect(await rewardVault.creditedRewards(user2.address)).to.equal(0n);
  });

  it("a sniper that buys big AFTER notify only earns from new emissions, not back-dated", async function () {
    const { owner, user1, user2, mmm, taxVault, rewardVault, minBalance } =
      await loadFixture(coreFixture);

    // user1 holds the long position.
    await mmm.transfer(user1.address, ethers.parseUnits("1000", 18));

    // user2 holds a tiny but eligible position.
    await mmm.transfer(user2.address, minBalance);

    // First emission accrues to both, weighted by current balances.
    await notifyAs(
      taxVault,
      rewardVault,
      ethers.parseUnits("400", 18)
    );

    const sniperPendingBefore = await rewardVault.pending(user2.address);

    // Sniper now buys 100x to try to drain.
    await mmm.transfer(user2.address, ethers.parseUnits("10000", 18));

    // Pending after the big buy must NOT scale up to the new balance —
    // only the credit captured from the OLD balance plus any future
    // accRewardPerToken increase against the new balance counts.
    const sniperPendingAfter = await rewardVault.pending(user2.address);
    expect(sniperPendingAfter).to.equal(0n);

    const credit = await rewardVault.creditedRewards(user2.address);
    // Credit should equal the pre-buy pending (rewards earned at minBalance).
    expect(credit).to.equal(sniperPendingBefore);

    // Total claimable (credit + pending) should reflect the OLD balance,
    // not the post-buy balance.
    const claimable = await rewardVault.claimable(user2.address);
    expect(claimable).to.equal(sniperPendingBefore);
  });

});
