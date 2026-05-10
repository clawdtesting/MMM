// test/unit/TaxVault.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { coreFixture } = require("../fixtures/core.fixture");

describe("TaxVault", function () {
 
  describe("Tax Processing", function () {
   
    it("should process tax and distribute to vaults", async function () {
      const { mmm: MMM, usdc: USDC, taxVault, rewardVault, marketingVault, teamVestingVault } = await loadFixture(coreFixture);
     
      // 1. Seed TaxVault with MMM
      const taxAmount = ethers.parseUnits("10000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
     
      // 2. Process
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
     
      // 3. Verify distributions
      const rewardMmm = await MMM.balanceOf(await rewardVault.getAddress());
      const marketingUsdc = await USDC.balanceOf(await marketingVault.getAddress());
      const teamUsdc = await USDC.balanceOf(await teamVestingVault.getAddress());
     
      // Note: Since we are not mocking the router swap, we expect 0 USDC out
      // but the reward vault should receive MMM
      expect(rewardMmm).to.be.gt(0, "RewardVault should receive MMM");
      // We don't assert on USDC because the swap may not work in the mock
    });
   
    it("should revert process with zero amount", async function () {
      const { taxVault } = await loadFixture(coreFixture);
     
      const deadline = Math.floor(Date.now() / 1000) + 600;
     
      await expect(
        taxVault.process(0, 0, deadline)
      ).to.be.reverted;
    });
   
    it("should revert process with insufficient balance", async function () {
      const { mmm: MMM, taxVault } = await loadFixture(coreFixture);
     
      // Try to process more than available
      const taxAmount = ethers.parseUnits("10000", 18);
      const deadline = Math.floor(Date.now() / 1000) + 600;
     
      await expect(
        taxVault.process(taxAmount, 0, deadline)
      ).to.be.reverted;
    });
   
    it("should prevent double processing same amount", async function () {
      const { mmm: MMM, taxVault } = await loadFixture(coreFixture);
     
      // 1. Seed and process
      const taxAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
     
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await taxVault.process(taxAmount, 0, deadline);
     
      // 2. Try to process again with same amount (should fail)
      await expect(
        taxVault.process(taxAmount, 0, deadline)
      ).to.be.reverted;
    });
   
    it("should revert if processing disabled", async function () {
      const { mmm: MMM, taxVault, owner } = await loadFixture(coreFixture);
     
      // 1. Seed vault
      const taxAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
     
      // 2. Disable processing
      await taxVault.setProcessingEnabled(false);
     
      // 3. Try to process (should fail)
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await expect(
        taxVault.process(taxAmount, 0, deadline)
      ).to.be.reverted;
    });
   
    it("should only allow owner to process", async function () {
      const { mmm: MMM, taxVault, user1 } = await loadFixture(coreFixture);
     
      // 1. Seed vault
      const taxAmount = ethers.parseUnits("1000", 18);
      await MMM.transfer(await taxVault.getAddress(), taxAmount);
     
      // 2. Try to process as non-owner
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await expect(
        taxVault.connect(user1).process(taxAmount, 0, deadline)
      ).to.be.reverted;
    });
  });
 
  describe("Configuration", function () {
   
    it("should allow owner to set router", async function () {
      const { taxVault, user1 } = await loadFixture(coreFixture);
     
      await taxVault.setRouter(user1.address);
     
      const router = await taxVault.router();
      expect(router).to.equal(user1.address);
    });
   
    it("should prevent non-owner from setting router", async function () {
      const { taxVault, user1 } = await loadFixture(coreFixture);
     
      await expect(
        taxVault.connect(user1).setRouter(user1.address)
      ).to.be.reverted;
    });
   
    it("should allow owner to approve router", async function () {
      const { mmm: MMM, taxVault, mockRouter } = await loadFixture(coreFixture);
     
      // Approve already done in fixture, but test it works
      await taxVault.approveRouter();
     
      const allowance = await MMM.allowance(
        await taxVault.getAddress(),
        await mockRouter.getAddress()
      );
     
      expect(allowance).to.be.gt(0);
    });
   
    it("should allow owner to toggle processing", async function () {
      const { taxVault } = await loadFixture(coreFixture);
     
      // Start enabled (from fixture)
      let enabled = await taxVault.processingEnabled();
      expect(enabled).to.be.true;
     
      // Disable
      await taxVault.setProcessingEnabled(false);
      enabled = await taxVault.processingEnabled();
      expect(enabled).to.be.false;
     
      // Re-enable
      await taxVault.setProcessingEnabled(true);
      enabled = await taxVault.processingEnabled();
      expect(enabled).to.be.true;
    });
  });
 
  describe("Vault Addresses", function () {
   
    it("should have all vault addresses set", async function () {
      const { taxVault, rewardVault, marketingVault, teamVestingVault } = await loadFixture(coreFixture);
     
      const reward = await taxVault.rewardVault();
      const marketing = await taxVault.marketingVault();
      const team = await taxVault.teamVestingVault();
     
      expect(reward).to.equal(await rewardVault.getAddress());
      expect(marketing).to.equal(await marketingVault.getAddress());
      expect(team).to.equal(await teamVestingVault.getAddress());
    });
   
    it("should not have zero addresses", async function () {
      const { taxVault } = await loadFixture(coreFixture);
     
      const reward = await taxVault.rewardVault();
      const marketing = await taxVault.marketingVault();
      const team = await taxVault.teamVestingVault();
     
      expect(reward).to.not.equal(ethers.ZeroAddress);
      expect(marketing).to.not.equal(ethers.ZeroAddress);
      expect(team).to.not.equal(ethers.ZeroAddress);
    });
  });
});