const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { coreFixture } = require("./fixtures/core.fixture");

describe("TaxVault - Sell Tax Collection", function () {

  it("collects tax on sell to pair", async function () {

    const {
      owner,
      user1,
      pair,
      mmm,
      taxVault
    } = await loadFixture(coreFixture);

    // Give user1 tokens
    const amount = ethers.parseUnits("1000", 18);
    await mmm.transfer(user1.address, amount);

    const beforeTaxVault = await mmm.balanceOf(await taxVault.getAddress());

    // Sell: transfer to pair
    await mmm.connect(user1).transfer(pair.address, amount);

    const afterTaxVault = await mmm.balanceOf(await taxVault.getAddress());

    expect(afterTaxVault).to.be.gt(beforeTaxVault);

  });

});
