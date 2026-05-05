const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { coreFixture } = require("../fixtures/core.fixture");

describe("MMMToken — unit (basic ERC20)", function () {

  it("has the deployment-supplied name, symbol and decimals", async function () {
    const { mmm } = await loadFixture(coreFixture);
    expect(await mmm.name()).to.equal("Monad Money Machine");
    expect(await mmm.symbol()).to.equal("MMM");
    expect(await mmm.decimals()).to.equal(18);
  });

  it("mints the entire initial supply to the deployer-supplied owner", async function () {
    const { mmm, owner } = await loadFixture(coreFixture);
    expect(await mmm.balanceOf(owner.address)).to.equal(await mmm.totalSupply());
  });

  it("supports plain transfers between accounts", async function () {
    const { mmm, user1 } = await loadFixture(coreFixture);
    const amount = ethers.parseUnits("100", 18);
    await mmm.transfer(user1.address, amount);
    expect(await mmm.balanceOf(user1.address)).to.equal(amount);
  });

  it("supports approved transferFrom", async function () {
    const { mmm, user1, user2 } = await loadFixture(coreFixture);
    const amount = ethers.parseUnits("100", 18);
    await mmm.transfer(user1.address, amount);
    await mmm.connect(user1).approve(user2.address, amount);
    await mmm.connect(user2).transferFrom(user1.address, user2.address, amount);
    expect(await mmm.balanceOf(user2.address)).to.equal(amount);
  });

  it("reverts on transfer to the zero address", async function () {
    const { mmm } = await loadFixture(coreFixture);
    await expect(
      mmm.transfer(ethers.ZeroAddress, ethers.parseUnits("100", 18))
    ).to.be.reverted;
  });

  it("reverts on transfer exceeding balance", async function () {
    const { mmm, user1, user2 } = await loadFixture(coreFixture);
    await mmm.transfer(user1.address, ethers.parseUnits("10", 18));
    await expect(
      mmm.connect(user1).transfer(user2.address, ethers.parseUnits("100", 18))
    ).to.be.reverted;
  });

});

describe("MMMToken — unit (tax exemption admin)", function () {

  it("owner can set and unset tax exemption", async function () {
    const { mmm, user1 } = await loadFixture(coreFixture);
    await mmm.setTaxExempt(user1.address, true);
    expect(await mmm.isTaxExempt(user1.address)).to.be.true;
    await mmm.setTaxExempt(user1.address, false);
    expect(await mmm.isTaxExempt(user1.address)).to.be.false;
  });

  it("non-owner cannot set tax exemption", async function () {
    const { mmm, user1, user2 } = await loadFixture(coreFixture);
    await expect(
      mmm.connect(user1).setTaxExempt(user2.address, true)
    ).to.be.reverted;
  });

});

describe("MMMToken — unit (tax vault wiring)", function () {

  it("exposes the wired taxVault address", async function () {
    const { mmm, taxVault } = await loadFixture(coreFixture);
    expect(await mmm.taxVault()).to.equal(await taxVault.getAddress());
  });

  it("rejects a second setTaxVaultOnce", async function () {
    const { mmm, user1 } = await loadFixture(coreFixture);
    await expect(mmm.setTaxVaultOnce(user1.address)).to.be.reverted;
  });

  it("rejects zero address on first setTaxVaultOnce", async function () {
    // Deploy a fresh token (the fixture-bound one is already wired) and
    // verify the zero-address guard fires.
    const [signer] = await ethers.getSigners();
    const Tok = await ethers.getContractFactory("MMMToken");
    const fresh = await Tok.deploy("X", "X", 0, signer.address);
    await fresh.waitForDeployment();
    await expect(fresh.setTaxVaultOnce(ethers.ZeroAddress)).to.be.reverted;
  });

});

describe("MMMToken — unit (reward vault wiring)", function () {

  it("exposes the wired rewardVault address", async function () {
    const { mmm, rewardVault } = await loadFixture(coreFixture);
    expect(await mmm.rewardVault()).to.equal(await rewardVault.getAddress());
  });

  it("rejects a second setRewardVaultOnce", async function () {
    const { mmm, user1 } = await loadFixture(coreFixture);
    await expect(mmm.setRewardVaultOnce(user1.address)).to.be.reverted;
  });

});

describe("MMMToken — unit (lastNonZeroAt tracking)", function () {

  it("sets lastNonZeroAt on first receive from zero balance", async function () {
    const { mmm, user1 } = await loadFixture(coreFixture);
    expect(await mmm.balanceOf(user1.address)).to.equal(0n);
    await mmm.transfer(user1.address, ethers.parseUnits("100", 18));
    expect(await mmm.lastNonZeroAt(user1.address)).to.be.gt(0n);
  });

  it("clears lastNonZeroAt on full balance exit", async function () {
    const { mmm, owner, user1 } = await loadFixture(coreFixture);
    const amount = ethers.parseUnits("100", 18);
    await mmm.transfer(user1.address, amount);
    expect(await mmm.lastNonZeroAt(user1.address)).to.be.gt(0n);
    await mmm.connect(user1).transfer(owner.address, amount);
    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(0n);
  });

  it("preserves lastNonZeroAt on a partial sell", async function () {
    const { mmm, owner, user1 } = await loadFixture(coreFixture);
    await mmm.transfer(user1.address, ethers.parseUnits("100", 18));
    const before = await mmm.lastNonZeroAt(user1.address);
    await mmm.connect(user1).transfer(
      owner.address,
      ethers.parseUnits("40", 18)
    );
    expect(await mmm.lastNonZeroAt(user1.address)).to.equal(before);
  });

  it("balance-weights lastNonZeroAt forward on a top-up", async function () {
    // Receiving more tokens shifts lastNonZeroAt toward `now`,
    // proportional to the inflow vs prior balance. This is the
    // dust-resistance fix; old contract held the timestamp constant.
    const { mmm, user1 } = await loadFixture(coreFixture);
    const initial = ethers.parseUnits("100", 18);
    await mmm.transfer(user1.address, initial);
    const lnzInitial = await mmm.lastNonZeroAt(user1.address);

    await time.increase(1000);
    await mmm.transfer(user1.address, initial);

    const lnzAfter = await mmm.lastNonZeroAt(user1.address);
    expect(lnzAfter).to.be.gt(lnzInitial);
  });

});
