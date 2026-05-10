// test/unit/MMMToken.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { protocolFixture } = require("../fixtures/protocol.fixture");

describe("MMMToken", function () {
  
  describe("Basic Token Functions", function () {
    
    it("should have correct name and symbol", async function () {
      const { MMM } = await loadFixture(protocolFixture)
;
      
      expect(await MMM.name()).to.equal("MMM");
      expect(await MMM.symbol()).to.equal("MMM");
      expect(await MMM.decimals()).to.equal(18);
    });

    it("should mint initial supply to owner", async function () {
      const { MMM, owner } = await loadFixture(protocolFixture)
;
      
      const balance = await MMM.balanceOf(owner.address);
      const totalSupply = await MMM.totalSupply();
      
      expect(balance).to.be.gt(0);
      expect(totalSupply).to.be.gt(0);
    });

    it("should allow transfers between accounts", async function () {
      const { MMM, owner, user1 } = await loadFixture(protocolFixture)
;
      
      const amount = ethers.parseUnits("100", 18);
      await MMM.transfer(user1.address, amount);
      
      const balance = await MMM.balanceOf(user1.address);
      expect(balance).to.equal(amount);
    });

    it("should allow approved transfers", async function () {
      const { MMM, owner, user1, user2 } = await loadFixture(protocolFixture)
;
      
      // Give user1 tokens
      const amount = ethers.parseUnits("100", 18);
      await MMM.transfer(user1.address, amount);
      
      // User1 approves user2
      await MMM.connect(user1).approve(user2.address, amount);
      
      // User2 transfers from user1
      await MMM.connect(user2).transferFrom(user1.address, user2.address, amount);
      
      const balance = await MMM.balanceOf(user2.address);
      expect(balance).to.equal(amount);
    });
  });

  describe("Tax Exemptions", function () {
    
    it("should mark addresses as tax exempt", async function () {
      const { MMM, user1 } = await loadFixture(protocolFixture)
;
      
      await MMM.setTaxExempt(user1.address, true);
      
      const isExempt = await MMM.isTaxExempt(user1.address);
      expect(isExempt).to.be.true;
    });

    it("should remove tax exemption", async function () {
      const { MMM, user1 } = await loadFixture(protocolFixture)
;
      
      // Set exempt
      await MMM.setTaxExempt(user1.address, true);
      expect(await MMM.isTaxExempt(user1.address)).to.be.true;
      
      // Remove exempt
      await MMM.setTaxExempt(user1.address, false);
      expect(await MMM.isTaxExempt(user1.address)).to.be.false;
    });

    it("should only allow owner to set tax exemptions", async function () {
      const { MMM, user1, user2 } = await loadFixture(protocolFixture)
;
      
      await expect(
        MMM.connect(user1).setTaxExempt(user2.address, true)
      ).to.be.reverted;
    });
  });

  describe("Hold Timer Tracking", function () {
    
    it("should track lastNonZeroAt on first receive", async function () {
      const { MMM, user1 } = await loadFixture(protocolFixture)
;
      
      // User starts with 0 balance
      expect(await MMM.balanceOf(user1.address)).to.equal(0);
      
      // Transfer tokens
      const amount = ethers.parseUnits("100", 18);
      await MMM.transfer(user1.address, amount);
      
      // Check lastNonZeroAt is set
      const lastNonZeroAt = await MMM.lastNonZeroAt(user1.address);
      expect(lastNonZeroAt).to.be.gt(0);
    });

    it("should reset lastNonZeroAt when balance goes to zero", async function () {
      const { MMM, owner, user1 } = await loadFixture(protocolFixture)
;
      
      // Give user tokens
      const amount = ethers.parseUnits("100", 18);
      await MMM.transfer(user1.address, amount);
      
      const lastNonZeroAtBefore = await MMM.lastNonZeroAt(user1.address);
      expect(lastNonZeroAtBefore).to.be.gt(0);
      
      // Transfer all back (balance = 0)
      await MMM.connect(user1).transfer(owner.address, amount);
      
      // Should reset to 0
      const lastNonZeroAtAfter = await MMM.lastNonZeroAt(user1.address);
      expect(lastNonZeroAtAfter).to.equal(0);
    });

    it("should NOT reset lastNonZeroAt on additional receives", async function () {
      const { MMM, user1 } = await loadFixture(protocolFixture)
;
      
      // First transfer
      const amount1 = ethers.parseUnits("100", 18);
      await MMM.transfer(user1.address, amount1);
      
      const lastNonZeroAtFirst = await MMM.lastNonZeroAt(user1.address);
      
      // Second transfer (user still has balance)
      const amount2 = ethers.parseUnits("50", 18);
      await MMM.transfer(user1.address, amount2);
      
      const lastNonZeroAtSecond = await MMM.lastNonZeroAt(user1.address);
      
      // Should remain the same
      expect(lastNonZeroAtSecond).to.equal(lastNonZeroAtFirst);
    });
  });

  describe("Tax Vault Integration", function () {
    
    it("should allow setting tax vault", async function () {
      const { MMM, taxVault } = await loadFixture(protocolFixture)
;
      
      const vault = await MMM.taxVault();
      expect(vault).to.equal(await taxVault.getAddress());
    });

    it("should only allow owner to set tax vault", async function () {
      const { MMM, user1, user2 } = await loadFixture(protocolFixture)
;
      
      await expect(
        MMM.connect(user1).setTaxVault(user2.address)
      ).to.be.reverted;
    });

    it("should not allow zero address as tax vault", async function () {
      const { MMM } = await loadFixture(protocolFixture)
;
      
      await expect(
        MMM.setTaxVault(ethers.ZeroAddress)
      ).to.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    
    it("should handle multiple transfers in same block", async function () {
      const { MMM, user1, user2, user3 } = await loadFixture(protocolFixture)
;
      
      const amount = ethers.parseUnits("100", 18);
      
      // Send to multiple users
      await MMM.transfer(user1.address, amount);
      await MMM.transfer(user2.address, amount);
      await MMM.transfer(user3.address, amount);
      
      // All should have correct balances
      expect(await MMM.balanceOf(user1.address)).to.equal(amount);
      expect(await MMM.balanceOf(user2.address)).to.equal(amount);
      expect(await MMM.balanceOf(user3.address)).to.equal(amount);
    });

    it("should revert transfer to zero address", async function () {
      const { MMM } = await loadFixture(protocolFixture)
;
      
      const amount = ethers.parseUnits("100", 18);
      
      await expect(
        MMM.transfer(ethers.ZeroAddress, amount)
      ).to.be.reverted;
    });

    it("should revert transfer exceeding balance", async function () {
      const { MMM, user1, user2 } = await loadFixture(protocolFixture)
;
      
      // Give user1 small amount
      const amount = ethers.parseUnits("10", 18);
      await MMM.transfer(user1.address, amount);
      
      // Try to transfer more
      const tooMuch = ethers.parseUnits("100", 18);
      await expect(
        MMM.connect(user1).transfer(user2.address, tooMuch)
      ).to.be.reverted;
    });
  });
});