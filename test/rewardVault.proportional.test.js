const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, network } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

describe("RewardVault - Proportional Distribution", function () {

  it("distributes rewards proportionally to balances", async function () {

    const {
      user1,
      user2,
      mmm,
      taxVault,
      rewardVault,
      minHoldTime
    } = await loadFixture(coreFixture);

    // Give different balances. Owner is not the AMM pair, so neither
    // transfer is taxed and balances land at the requested amounts.
    const amount1 = ethers.parseUnits("1000", 18);
    const amount2 = ethers.parseUnits("3000", 18);

    await mmm.transfer(user1.address, amount1);
    await mmm.transfer(user2.address, amount2);

    await time.increase(minHoldTime + 1);

    // Emit rewards. coreFixture transfers RewardVault ownership to TaxVault
    // (production wiring), so we impersonate TaxVault to call notify.
    const rewardAmount = ethers.parseUnits("400", 18);
    await mmm.transfer(await rewardVault.getAddress(), rewardAmount);

    const taxVaultAddr = await taxVault.getAddress();
    await network.provider.send("hardhat_impersonateAccount", [taxVaultAddr]);
    await network.provider.send("hardhat_setBalance", [
      taxVaultAddr,
      "0x56BC75E2D63100000", // 100 ETH
    ]);
    const taxVaultSigner = await ethers.getSigner(taxVaultAddr);
    await rewardVault.connect(taxVaultSigner).notifyRewardAmount(rewardAmount);
    await network.provider.send("hardhat_stopImpersonatingAccount", [taxVaultAddr]);

    const pending1 = await rewardVault.pending(user1.address);
    const pending2 = await rewardVault.pending(user2.address);

    expect(pending1).to.be.gt(0n);
    expect(pending2).to.be.gt(0n);

    // user2 has 3x balance of user1 → should receive 3x reward
    const ratio = pending2 / pending1;
    expect(ratio).to.equal(3n);

  });

});
