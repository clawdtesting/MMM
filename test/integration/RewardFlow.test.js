// test/integration/RewardFlow.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture } = require("../fixtures/protocol.fixture");

describe("Integration: Complete Reward Flow", function () {
  
  it("should execute full buy → process → hold → claim flow", async function () {
    const { MMM, USDC, taxVault, rewardVault, owner, user1 } = await loadFixture(deployFixture);
    
    console.log("\n=== FULL REWARD FLOW TEST ===\n");
    
    // ==================== STEP 1: USER BUYS MMM ====================
    console.log("Step 1: User buys MMM tokens");
    const buyAmount = ethers.parseUnits("1000", 18);
    await MMM.transfer(user1.address, buyAmount);
    
    const userBalance = await MMM.balanceOf(user1.address);
    console.log(`  ✓ User balance: ${ethers.formatUnits(userBalance, 18)} MMM`);
    expect(userBalance).to.equal(buyAmount);
    
    // ==================== STEP 2: TAX ACCUMULATES ====================
    console.log("\nStep 2: Tax accumulates in TaxVault");
    const taxAmount = ethers.parseUnits("10000", 18);
    await MMM.transfer(await taxVault.getAddress(), taxAmount);
    
    const taxBalance = await MMM.balanceOf(await taxVault.getAddress());
    console.log(`  ✓ TaxVault balance: ${ethers.formatUnits(taxBalance, 18)} MMM`);
    expect(taxBalance).to.equal(taxAmount);
    
    // ==================== STEP 3: PROCESS TAX ====================
    console.log("\nStep 3: Process tax and distribute");
    const deadline = Math.floor(Date.now() / 1000) + 600;
    
    const rewardVaultAddress = await rewardVault.getAddress();
    const rewardBalanceBefore = await MMM.balanceOf(rewardVaultAddress);
    
    await taxVault.process(taxAmount, 0, deadline);
    
    const rewardBalanceAfter = await MMM.balanceOf(rewardVaultAddress);
    const distributed = rewardBalanceAfter - rewardBalanceBefore;
    console.log(`  ✓ Distributed to RewardVault: ${ethers.formatUnits(distributed, 18)} MMM`);
    expect(distributed).to.be.gt(0);
    
    // ==================== STEP 4: CHECK PENDING REWARDS ====================
    console.log("\nStep 4: Check user's pending rewards");
    const pendingBefore = await rewardVault.pending(user1.address);
    console.log(`  ✓ Pending rewards: ${ethers.formatUnits(pendingBefore, 18)} MMM`);
    expect(pendingBefore).to.be.gt(0);
    
    // ==================== STEP 5: WAIT FOR HOLD PERIOD ====================
    console.log("\nStep 5: Wait for hold period");
    const minHoldTime = await rewardVault.minHoldTimeSec();
    console.log(`  ⏱  Hold requirement: ${minHoldTime} seconds`);
    
    await time.increase(minHoldTime);
    console.log(`  ✓ Time advanced by ${minHoldTime} seconds`);
    
    // ==================== STEP 6: CLAIM REWARDS ====================
    console.log("\nStep 6: User claims rewards");
    const userBalanceBeforeClaim = await MMM.balanceOf(user1.address);
    const usdcBalanceBeforeClaim = await USDC.balanceOf(user1.address);
    
    await rewardVault.connect(user1).claim();
    
    const userBalanceAfterClaim = await MMM.balanceOf(user1.address);
    const usdcBalanceAfterClaim = await USDC.balanceOf(user1.address);
    
    const mmmGained = userBalanceAfterClaim - userBalanceBeforeClaim;
    const usdcGained = usdcBalanceAfterClaim - usdcBalanceBeforeClaim;
    
    console.log(`  ✓ MMM claimed: ${ethers.formatUnits(mmmGained, 18)}`);
    console.log(`  ✓ USDC boost: ${ethers.formatUnits(usdcGained, 6)}`);
    
    expect(mmmGained).to.be.gt(0, "User should receive MMM rewards");
    expect(usdcGained).to.be.gt(0, "User should receive USDC boost");
    
    // ==================== STEP 7: VERIFY NO DOUBLE CLAIM ====================
    console.log("\nStep 7: Verify cooldown prevents immediate re-claim");
    await expect(
      rewardVault.connect(user1).claim()
    ).to.be.reverted;
    console.log("  ✓ Cooldown working correctly");
    
    console.log("\n=== TEST COMPLETE ===\n");
  });

  it("should handle buy → sell → re-buy scenario correctly", async function () {
    const { MMM, rewardVault, taxVault, owner, user1 } = await loadFixture(deployFixture);
    
    console.log("\n=== BUY → SELL → RE-BUY FLOW ===\n");
    
    // ==================== BUY ====================
    console.log("Step 1: User buys MMM");
    const buyAmount = ethers.parseUnits("500", 18);
    await MMM.transfer(user1.address, buyAmount);
    
    const lastNonZeroAtAfterBuy = await MMM.lastNonZeroAt(user1.address);
    console.log(`  ✓ Hold timer started at: ${lastNonZeroAtAfterBuy}`);
    
    // ==================== SELL ALL ====================
    console.log("\nStep 2: User sells all MMM");
    const balance = await MMM.balanceOf(user1.address);
    await MMM.connect(user1).transfer(owner.address, balance);
    
    const balanceAfterSell = await MMM.balanceOf(user1.address);
    expect(balanceAfterSell).to.equal(0);
    console.log("  ✓ Balance now zero");
    
    const lastNonZeroAtAfterSell = await MMM.lastNonZeroAt(user1.address);
    expect(lastNonZeroAtAfterSell).to.equal(0);
    console.log("  ✓ Hold timer reset to zero");
    
    // ==================== RE-BUY ====================
    console.log("\nStep 3: User re-buys MMM");
    await time.increase(100); // Small time gap
    await MMM.transfer(user1.address, buyAmount);
    
    const lastNonZeroAtAfterRebuy = await MMM.lastNonZeroAt(user1.address);
    console.log(`  ✓ New hold timer: ${lastNonZeroAtAfterRebuy}`);
    
    // Timer should be different (newer)
    expect(lastNonZeroAtAfterRebuy).to.be.gt(lastNonZeroAtAfterBuy);
    
    // ==================== CREATE EMISSIONS ====================
    console.log("\nStep 4: Create emissions");
    const taxAmount = ethers.parseUnits("10000", 18);
    await MMM.transfer(await taxVault.getAddress(), taxAmount);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);
    
    // ==================== TRY TO CLAIM (SHOULD FAIL) ====================
    console.log("\nStep 5: Try to claim (should fail - new hold period)");
    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(BigInt(minHoldTime) - 200n); // Not quite enough time
    
    await expect(
      rewardVault.connect(user1).claim()
    ).to.be.reverted;
    console.log("  ✓ Claim correctly blocked");
    
    // ==================== WAIT FULL TIME AND CLAIM ====================
    console.log("\nStep 6: Wait full hold period and claim");
    await time.increase(300n); // Now enough time

    await rewardVault.connect(user1).claim();
    console.log("  ✓ Claim successful after full hold period");

    console.log("\n=== TEST COMPLETE ===\n");
  });

  it("should handle multiple users competing for rewards", async function () {
    const { MMM, rewardVault, taxVault, user1, user2, user3 } = await loadFixture(deployFixture);
    
    console.log("\n=== MULTIPLE USERS COMPETING ===\n");
    
    // ==================== ALL USERS BUY ====================
    console.log("Step 1: Multiple users buy different amounts");
    await MMM.transfer(user1.address, ethers.parseUnits("1000", 18));
    await MMM.transfer(user2.address, ethers.parseUnits("2000", 18));
    await MMM.transfer(user3.address, ethers.parseUnits("500", 18));
    
    console.log("  ✓ User1: 1000 MMM");
    console.log("  ✓ User2: 2000 MMM (2x user1)");
    console.log("  ✓ User3: 500 MMM (0.5x user1)");
    
    // ==================== PROCESS TAX ====================
    console.log("\nStep 2: Process tax to create rewards");
    const taxAmount = ethers.parseUnits("10000", 18);
    await MMM.transfer(await taxVault.getAddress(), taxAmount);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);
    
    // ==================== CHECK PENDING (PROPORTIONAL) ====================
    console.log("\nStep 3: Check pending rewards (should be proportional)");
    const pending1 = await rewardVault.pending(user1.address);
    const pending2 = await rewardVault.pending(user2.address);
    const pending3 = await rewardVault.pending(user3.address);
    
    console.log(`  User1 pending: ${ethers.formatUnits(pending1, 18)} MMM`);
    console.log(`  User2 pending: ${ethers.formatUnits(pending2, 18)} MMM`);
    console.log(`  User3 pending: ${ethers.formatUnits(pending3, 18)} MMM`);
    
    // User2 should have ~2x User1's rewards
    const ratio2to1 = (pending2 * 100n) / pending1;
    console.log(`  Ratio User2/User1: ${ratio2to1}%`);
    expect(ratio2to1).to.be.closeTo(200n, 20n);
    
    // User3 should have ~0.5x User1's rewards
    const ratio3to1 = (pending3 * 100n) / pending1;
    console.log(`  Ratio User3/User1: ${ratio3to1}%`);
    expect(ratio3to1).to.be.closeTo(50n, 10n);
    
    // ==================== ALL CLAIM ====================
    console.log("\nStep 4: All users claim after hold period");
    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(minHoldTime);
    
    const bal1Before = await MMM.balanceOf(user1.address);
    const bal2Before = await MMM.balanceOf(user2.address);
    const bal3Before = await MMM.balanceOf(user3.address);
    
    await rewardVault.connect(user1).claim();
    await rewardVault.connect(user2).claim();
    await rewardVault.connect(user3).claim();
    
    const bal1After = await MMM.balanceOf(user1.address);
    const bal2After = await MMM.balanceOf(user2.address);
    const bal3After = await MMM.balanceOf(user3.address);
    
    const gained1 = bal1After - bal1Before;
    const gained2 = bal2After - bal2Before;
    const gained3 = bal3After - bal3Before;
    
    console.log(`  User1 gained: ${ethers.formatUnits(gained1, 18)} MMM`);
    console.log(`  User2 gained: ${ethers.formatUnits(gained2, 18)} MMM`);
    console.log(`  User3 gained: ${ethers.formatUnits(gained3, 18)} MMM`);
    
    expect(gained1).to.be.gt(0);
    expect(gained2).to.be.gt(0);
    expect(gained3).to.be.gt(0);
    
    console.log("\n=== TEST COMPLETE ===\n");
  });

  it("should handle partial sell scenario", async function () {
    // Design: partial sells do NOT reset the hold timer. lastNonZeroAt only
    // resets when a wallet's balance fully exits to zero and re-enters from
    // zero. A partial sell that leaves a non-zero balance preserves the
    // original entry timestamp, so the user remains eligible to claim once
    // the hold period elapses (with rewards proportional to remaining
    // balance). See MMMToken._syncLastNonZero and rewardVault.partialSell.test.
    const { MMM, rewardVault, taxVault, owner, user1 } = await loadFixture(deployFixture);

    console.log("\n=== PARTIAL SELL SCENARIO ===\n");

    // ==================== BUY ====================
    console.log("Step 1: User buys MMM");
    const buyAmount = ethers.parseUnits("1000", 18);
    await MMM.transfer(user1.address, buyAmount);

    const lnzBefore = await MMM.lastNonZeroAt(user1.address);

    // ==================== PARTIAL SELL ====================
    console.log("\nStep 2: User sells 50% of holdings");
    const balance = await MMM.balanceOf(user1.address);
    const sellAmount = balance / 2n;
    await MMM.connect(user1).transfer(owner.address, sellAmount);

    const remainingBalance = await MMM.balanceOf(user1.address);
    console.log(`  ✓ Remaining balance: ${ethers.formatUnits(remainingBalance, 18)} MMM`);
    expect(remainingBalance).to.equal(balance - sellAmount);

    // Hold timer must NOT reset on partial sell
    const lnzAfter = await MMM.lastNonZeroAt(user1.address);
    expect(lnzAfter).to.equal(lnzBefore);

    // ==================== CREATE REWARDS ====================
    console.log("\nStep 3: Create rewards");
    const taxAmount = ethers.parseUnits("10000", 18);
    await MMM.transfer(await taxVault.getAddress(), taxAmount);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await taxVault.process(taxAmount, 0, deadline);

    const pending = await rewardVault.pending(user1.address);
    console.log(`  ✓ Pending rewards: ${ethers.formatUnits(pending, 18)} MMM`);
    expect(pending).to.be.gt(0);

    // ==================== CLAIM AFTER HOLD ====================
    console.log("\nStep 4: Claim after hold period (should succeed)");
    const minHoldTime = await rewardVault.minHoldTimeSec();
    await time.increase(minHoldTime);

    const balBefore = await MMM.balanceOf(user1.address);
    await rewardVault.connect(user1).claim();
    const balAfter = await MMM.balanceOf(user1.address);

    expect(balAfter).to.be.gt(balBefore);
    console.log("  ✓ Claim succeeded; partial sell preserved hold eligibility");

    console.log("\n=== TEST COMPLETE ===\n");
  });
});