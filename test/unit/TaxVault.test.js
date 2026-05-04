const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { coreFixture } = require("../fixtures/core.fixture");

describe("TaxVault — unit (process flow)", function () {

  it("splits MMM into reward / burn / swap and routes USDC out", async function () {
    const {
      mmm,
      usdc,
      taxVault,
      rewardVault,
      marketingVault,
      teamVestingVault
    } = await loadFixture(coreFixture);

    const taxAmount = ethers.parseUnits("10000", 18);
    await mmm.transfer(await taxVault.getAddress(), taxAmount);

    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);

    expect(await mmm.balanceOf(await rewardVault.getAddress())).to.be.gt(0n);
    expect(await usdc.balanceOf(await marketingVault.getAddress())).to.be.gt(0n);
    expect(await usdc.balanceOf(await teamVestingVault.getAddress())).to.be.gt(0n);

    // TaxVault drained
    expect(await mmm.balanceOf(await taxVault.getAddress())).to.equal(0n);
  });

  it("reverts process(0)", async function () {
    const { taxVault } = await loadFixture(coreFixture);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await expect(taxVault.process(0n, 0, deadline)).to.be.reverted;
  });

  it("reverts process exceeding TaxVault balance", async function () {
    const { taxVault } = await loadFixture(coreFixture);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await expect(
      taxVault.process(ethers.parseUnits("10000", 18), 0, deadline)
    ).to.be.reverted;
  });

  it("reverts when processing is disabled", async function () {
    const { mmm, taxVault } = await loadFixture(coreFixture);
    const taxAmount = ethers.parseUnits("1000", 18);
    await mmm.transfer(await taxVault.getAddress(), taxAmount);

    await taxVault.setProcessingEnabled(false);

    const deadline = Math.floor(Date.now() / 1000) + 600;
    await expect(
      taxVault.process(taxAmount, 0, deadline)
    ).to.be.reverted;
  });

});

describe("TaxVault — unit (admin / wiring)", function () {

  it("returns wired vault addresses", async function () {
    const {
      taxVault,
      rewardVault,
      marketingVault,
      teamVestingVault
    } = await loadFixture(coreFixture);

    expect(await taxVault.rewardVault()).to.equal(await rewardVault.getAddress());
    expect(await taxVault.marketingVault()).to.equal(await marketingVault.getAddress());
    expect(await taxVault.teamVestingVault()).to.equal(await teamVestingVault.getAddress());
  });

  it("router is approved for unlimited MMM", async function () {
    const { mmm, taxVault, mockRouter } = await loadFixture(coreFixture);
    const allowance = await mmm.allowance(
      await taxVault.getAddress(),
      await mockRouter.getAddress()
    );
    expect(allowance).to.be.gt(0n);
  });

  it("only owner can set router", async function () {
    const { taxVault, user1 } = await loadFixture(coreFixture);
    await expect(
      taxVault.connect(user1).setRouter(user1.address)
    ).to.be.reverted;
  });

  it("only owner can toggle processing", async function () {
    const { taxVault, user1 } = await loadFixture(coreFixture);
    await expect(
      taxVault.connect(user1).setProcessingEnabled(false)
    ).to.be.reverted;
  });

  it("processing is enabled by default", async function () {
    const { taxVault } = await loadFixture(coreFixture);
    expect(await taxVault.processingEnabled()).to.be.true;
  });

});
