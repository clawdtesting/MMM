const { ethers, network } = require("hardhat");

// Notify rewards by impersonating the production owner of RewardVault.
// In coreFixture, RewardVault ownership is handed to TaxVault as in
// production wiring. Direct unit tests therefore impersonate TaxVault to
// drive notifyRewardAmount; the protocol path goes through
// taxVault.process() and is exercised separately.
async function notifyAs(taxVault, rewardVault, amount) {
  const addr = await taxVault.getAddress();
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  const signer = await ethers.getSigner(addr);
  await rewardVault.connect(signer).notifyRewardAmount(amount);
  await network.provider.send("hardhat_stopImpersonatingAccount", [addr]);
}

module.exports = { notifyAs };
