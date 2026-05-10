// test/unit/RewardVault.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { protocolFixture } = require("../fixtures/protocol.fixture");

describe("RewardVault", function () {
  
  describe("Claiming Rewards", function () {
    
    it("should allow claim after hold period is met", async function () {
      const { MMM, rewardVault, taxVault, owner, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Give user1 some MMM tokens
      const buyAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      // 2. Create emission by processing tax
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 3. Fast forward time to meet hold requirement
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      // 4. Check pending rewards
      const pending = await rewardVault.pending(user1.address);
      expect(pending).to.be.gt(0, "User should have pending rewards");
      
      // 5. Claim
      const balanceBefore = await MMM.balanceOf(user1.address);
      await rewardVault.connect(user1).claim();
      const balanceAfter = await MMM.balanceOf(user1.address);
      
      // 6. Verify reward received
      expect(balanceAfter).to.be.gt(balanceBefore, "User should receive rewards");
    });

    it("should revert claim before hold period", async function () {
      const { MMM, rewardVault, taxVault, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Give user MMM tokens
      const buyAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      // 2. Create emission
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 3. Try to claim immediately (should fail)
      await expect(
        rewardVault.connect(user1).claim()
      ).to.be.reverted;
    });

    it("should revert claim with zero balance", async function () {
      const { rewardVault, user1 } = await loadFixture(protocolFixture)
;
      
      // User has no MMM tokens
      await expect(
        rewardVault.connect(user1).claim()
      ).to.be.reverted;
    });

    it("should revert claim when no rewards pending", async function () {
      const { MMM, rewardVault, user1 } = await loadFixture(protocolFixture)
;
      
      // Give user tokens but no emissions created
      const buyAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      // Fast forward time
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      // Try to claim (should fail - no rewards)
      await expect(
        rewardVault.connect(user1).claim()
      ).to.be.reverted;
    });

    it("should enforce cooldown between claims", async function () {
      const { MMM, rewardVault, taxVault, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Setup and first claim
      const buyAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      await rewardVault.connect(user1).claim();
      
      // 2. Create more emissions
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      await taxVault.process(taxAmount, 0, deadline + 600);
      
      // 3. Try to claim again immediately (should fail - cooldown)
      await expect(
        rewardVault.connect(user1).claim()
      ).to.be.reverted;
      
      // 4. Wait for cooldown
      const cooldown = await rewardVault.claimCooldown();
      await time.increase(cooldown);
      
      // 5. Should succeed now
      await expect(
        rewardVault.connect(user1).claim()
      ).to.not.be.reverted;
    });

    it("should block claim below minimum balance", async function () {
      const { MMM, rewardVault, taxVault, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Get minBalance requirement
      const minBalance = await rewardVault.minBalance();
      
      // 2. Give user dust amount (below minimum)
      const dustAmount = minBalance > 1n ? minBalance - 1n : 1n;
      await MMM.transfer(user1.address, dustAmount);
      
      // 3. Create emissions
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 4. Fast forward time
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      // 5. Should fail to claim
      await expect(
        rewardVault.connect(user1).claim()
      ).to.be.reverted;
    });
  });

  describe("Hold Period Reset", function () {
    
    it("should reset hold timer after full sell", async function () {
      const { MMM, rewardVault, owner, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Buy
      const buyAmount = ethers.parseUnits("500", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      // 2. Sell all
      const balance = await MMM.balanceOf(user1.address);
      await MMM.connect(user1).transfer(owner.address, balance);
      
      // 3. Check that balance is zero
      const finalBalance = await MMM.balanceOf(user1.address);
      expect(finalBalance).to.equal(0);
      
      // 4. Buy again
      await MMM.transfer(user1.address, buyAmount);
      
      // 5. Verify lastNonZeroAt was reset (should be recent)
      const lastNonZeroAt = await MMM.lastNonZeroAt(user1.address);
      const currentTime = await time.latest();
      
      expect(lastNonZeroAt).to.be.closeTo(
        BigInt(currentTime),
        10n,
        "Hold timer should be reset to recent timestamp"
      );
    });

    it("should reset hold timer after partial sell", async function () {
      const { MMM, rewardVault, taxVault, owner, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Buy
      const buyAmount = ethers.parseUnits("400", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      // 2. Partial sell (50%)
      const balance = await MMM.balanceOf(user1.address);
      const sellAmount = balance / 2n;
      await MMM.connect(user1).transfer(owner.address, sellAmount);
      
      // 3. Create emissions
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 4. Fast forward time
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      // 5. Should not be able to claim (hold reset after partial sell)
      await expect(
        rewardVault.connect(user1).claim()
      ).to.be.reverted;
    });

    it("should NOT reset hold timer on transfer between non-zero balances", async function () {
      const { MMM, rewardVault, taxVault, owner, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Give user initial balance
      const initialAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, initialAmount);
      
      const lastNonZeroAtBefore = await MMM.lastNonZeroAt(user1.address);
      
      // 2. Add more tokens (user already has balance)
      await time.increase(100); // wait a bit
      const additionalAmount = ethers.parseUnits("500", 18);
      await MMM.transfer(user1.address, additionalAmount);
      
      // 3. Verify hold timer NOT reset
      const lastNonZeroAtAfter = await MMM.lastNonZeroAt(user1.address);
      expect(lastNonZeroAtAfter).to.equal(
        lastNonZeroAtBefore,
        "Hold timer should NOT reset when receiving tokens while having balance"
      );
    });
  });

  describe("Reward Distribution", function () {
    
    it("should distribute rewards proportionally to holders", async function () {
      const { MMM, rewardVault, taxVault, user1, user2 } = await loadFixture(protocolFixture)
;
      
      // 1. Give tokens to two users (user1 gets 3x more)
      const user2Amount = ethers.parseUnits("1000", 18);
      const user1Amount = ethers.parseUnits("3000", 18);
      
      await MMM.transfer(user1.address, user1Amount);
      await MMM.transfer(user2.address, user2Amount);
      
      // 2. Create emissions
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 3. Fast forward time
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      // 4. Check pending rewards
      const pending1 = await rewardVault.pending(user1.address);
      const pending2 = await rewardVault.pending(user2.address);
      
      // 5. User1 should have ~3x more rewards than user2
      const ratio = pending1 * 100n / pending2;
      expect(ratio).to.be.closeTo(300n, 50n, "User1 should have ~3x rewards");
    });

    it("should not accrue rewards for tax-exempt addresses", async function () {
      const { MMM, rewardVault, taxVault, swapVault } = await loadFixture(protocolFixture)
;
      
      // 1. SwapVault is tax-exempt and has MMM
      const swapVaultAddress = await swapVault.getAddress();
      const swapBalance = await MMM.balanceOf(swapVaultAddress);
      
      // 2. Create emissions
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 3. Check pending for swap vault (should be 0)
      const pending = await rewardVault.pending(swapVaultAddress);
      expect(pending).to.equal(0, "Tax-exempt addresses should not accrue rewards");
    });
  });

  describe("Edge Cases", function () {
    
    it("should handle multiple users claiming in sequence", async function () {
      const { MMM, rewardVault, taxVault, user1, user2, user3 } = await loadFixture(protocolFixture)
;
      
      // 1. Give tokens to multiple users
      const amount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, amount);
      await MMM.transfer(user2.address, amount);
      await MMM.transfer(user3.address, amount);
      
      // 2. Create large emissions
      const taxAmount = ethers.parseUnits("30000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      // 3. Fast forward time
      const minHoldTime = await rewardVault.minHoldTimeSec();
      await time.increase(minHoldTime);
      
      // 4. All claim in sequence
      await rewardVault.connect(user1).claim();
      await rewardVault.connect(user2).claim();
      await rewardVault.connect(user3).claim();
      
      // 5. All should have received rewards
      const balance1 = await MMM.balanceOf(user1.address);
      const balance2 = await MMM.balanceOf(user2.address);
      const balance3 = await MMM.balanceOf(user3.address);
      
      expect(balance1).to.be.gt(amount);
      expect(balance2).to.be.gt(amount);
      expect(balance3).to.be.gt(amount);
    });

    it("should handle zero emission notification", async function () {
      const { rewardVault } = await loadFixture(protocolFixture)
;
      
      // Should not revert with zero emission
      await expect(
        rewardVault.notifyRewardAmount(0)
      ).to.not.be.reverted;
    });

    it("should accumulate rewards across multiple emissions", async function () {
      const { MMM, rewardVault, taxVault, user1 } = await loadFixture(protocolFixture)
;
      
      // 1. Give user tokens
      const buyAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(user1.address, buyAmount);
      
      // 2. First emission
      const taxAmount = ethers.parseUnits("5000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
      
      const pendingAfterFirst = await rewardVault.pending(user1.address);
      
      // 3. Second emission
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
      await taxVault.process(taxAmount, 0, deadline + 600);
      
      const pendingAfterSecond = await rewardVault.pending(user1.address);
      
      // 4. Pending should increase
      expect(pendingAfterSecond).to.be.gt(
        pendingAfterFirst,
        "Rewards should accumulate"
      );
    });
  });
});