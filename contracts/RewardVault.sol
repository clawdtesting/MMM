// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/*//////////////////////////////////////////////////////////////
                        TOKEN INTERFACES
//////////////////////////////////////////////////////////////*/

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IMMMToken is IERC20Like {
    function lastNonZeroAt(address user) external view returns (uint256);
}

/*//////////////////////////////////////////////////////////////
                        BOOST NFT INTERFACE
//////////////////////////////////////////////////////////////*/

interface IBoostNFT {
    struct BoostConfig {
        uint32 holdReduction;
        uint32 cooldownReduction;
    }

    function getBoost(address user)
        external
        view
        returns (BoostConfig memory config, uint8);
}

/*//////////////////////////////////////////////////////////////
                            REWARD VAULT
//////////////////////////////////////////////////////////////*/

contract RewardVault is Ownable, ReentrancyGuard {

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error NothingToClaim();
    error BalanceBelowMin(address who, uint256 bal, uint256 minBal);
    error HoldTimeNotMet(address who);
    error ClaimCooldownActive(address who);
    error ZeroAmount();
    error EligibleSupplyZero();
    error ZeroAddress();
    error OnlyToken();

    uint256 public constant ACC_SCALE = 1e18;

    IMMMToken public immutable mmm;

    uint48  public immutable minHoldTimeSec;
    uint48  public immutable claimCooldown;
    uint256 public immutable minBalance;

    IBoostNFT public boostNFT;

    /*//////////////////////////////////////////////////////////////
                            ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    uint256 public totalDistributed;
    uint256 public totalClaimed;          // NEW
    uint256 public accRewardPerToken;     // Monotonic

    mapping(address => uint256) public rewardDebt;
    mapping(address => uint48)  public lastClaimAt;

    // Crystallised, unclaimed rewards. Captured on every token transfer via
    // the pre/post hooks below so new buyers cannot retro-claim against the
    // historical accRewardPerToken (issues.txt #5 and #7).
    mapping(address => uint256) public claimable;

    /*//////////////////////////////////////////////////////////////
                        SUPPLY EXCLUSION
    //////////////////////////////////////////////////////////////*/

    address[] public excludedRewardAddresses;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BoostNFTSet(address indexed boostNFT);
    event Notified(uint256 amount, uint256 eligibleSupply, uint256 newAcc);
    event Claimed(address indexed user, uint256 amount);
    event Crystallised(address indexed user, uint256 added, uint256 totalClaimable);

    /*//////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyToken() {
        if (msg.sender != address(mmm)) revert OnlyToken();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _mmm,
        uint48  _minHoldTimeSec,
        uint48  _claimCooldown,
        uint256 _minBalance,
        address initialOwner
    ) Ownable(initialOwner) {

        if (_mmm == address(0) || initialOwner == address(0))
            revert ZeroAddress();

        mmm = IMMMToken(_mmm);

        minHoldTimeSec = _minHoldTimeSec;
        claimCooldown  = _claimCooldown;
        minBalance     = _minBalance;

        // Exclude vault itself
        excludedRewardAddresses.push(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                            VIEWS
    //////////////////////////////////////////////////////////////*/

    function eligibleSupply() public view returns (uint256) {

        uint256 ts = mmm.totalSupply();
        uint256 sumExcluded;

        uint256 n = excludedRewardAddresses.length;

        for (uint256 i = 0; i < n; i++) {
            sumExcluded += mmm.balanceOf(excludedRewardAddresses[i]);
        }

        return ts - sumExcluded;
    }

    function pending(address user) public view returns (uint256) {

        uint256 bal = mmm.balanceOf(user);

        if (bal < minBalance) return 0;

        uint256 accrued = (bal * accRewardPerToken) / ACC_SCALE;
        uint256 debt = rewardDebt[user];

        uint256 unclaimedFromCurrent =
            accrued > debt ? accrued - debt : 0;

        return claimable[user] + unclaimedFromCurrent;
    }

    function holdRemaining(address user) external view returns (uint256) {
        if (mmm.balanceOf(user) < minBalance) return 0;

        if (lastClaimAt[user] != 0) return 0;

        uint256 effectiveHold = minHoldTimeSec;

        if (address(boostNFT) != address(0)) {
            try boostNFT.getBoost(user)
                returns (IBoostNFT.BoostConfig memory cfg, uint8)
            {
                if (cfg.holdReduction >= effectiveHold)
                    effectiveHold = 0;
                else
                    effectiveHold -= cfg.holdReduction;
            } catch {}
        }

        uint256 unlockTime =
            mmm.lastNonZeroAt(user) + effectiveHold;

        if (block.timestamp >= unlockTime) return 0;

        return unlockTime - block.timestamp;
    }


    function cooldownRemaining(address user) external view returns (uint256) {
        uint48 last = lastClaimAt[user];
        if (last == 0) return 0;

        uint256 effectiveCooldown = claimCooldown;

        if (address(boostNFT) != address(0)) {
            try boostNFT.getBoost(user)
                returns (IBoostNFT.BoostConfig memory cfg, uint8)
            {
                if (cfg.cooldownReduction >= effectiveCooldown)
                    effectiveCooldown = 0;
                else
                    effectiveCooldown -= cfg.cooldownReduction;
            } catch {}
        }

        uint256 unlockTime = uint256(last) + effectiveCooldown;
        if (block.timestamp >= unlockTime) return 0;
        return unlockTime - block.timestamp;
    }



    /*//////////////////////////////////////////////////////////////
                            ADMIN
    //////////////////////////////////////////////////////////////*/

    function setBoostNFT(address boostNFT_) external onlyOwner {
        boostNFT = IBoostNFT(boostNFT_);
        emit BoostNFTSet(boostNFT_);
    }

    function addExcludedRewardAddress(address a) external onlyOwner {
        excludedRewardAddresses.push(a);
    }

    function notifyRewardAmount(uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();

        uint256 denom = eligibleSupply();
        if (denom == 0) revert EligibleSupplyZero();

        accRewardPerToken += (amount * ACC_SCALE) / denom;
        totalDistributed  += amount;

        emit Notified(amount, denom, accRewardPerToken);
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIM
    //////////////////////////////////////////////////////////////*/

    function claim()
        external
        nonReentrant
        returns (uint256 claimed)
    {
        address user = msg.sender;

        uint256 bal = mmm.balanceOf(user);

        if (bal < minBalance)
            revert BalanceBelowMin(user, bal, minBalance);

        uint256 nowTs = block.timestamp;

        /* ---------- HOLD (FIRST CLAIM ONLY) ---------- */

        if (lastClaimAt[user] == 0) {

            uint256 effectiveHold = minHoldTimeSec;

            if (address(boostNFT) != address(0)) {
                try boostNFT.getBoost(user)
                    returns (IBoostNFT.BoostConfig memory cfg, uint8)
                {
                    if (cfg.holdReduction >= effectiveHold)
                        effectiveHold = 0;
                    else
                        effectiveHold -= cfg.holdReduction;
                } catch {}
            }

            uint256 lnz = mmm.lastNonZeroAt(user);

            if (nowTs < lnz + effectiveHold)
                revert HoldTimeNotMet(user);
        }

        /* ---------- COOLDOWN ---------- */

        uint256 effectiveCooldown = claimCooldown;

        if (address(boostNFT) != address(0)) {
            try boostNFT.getBoost(user)
                returns (IBoostNFT.BoostConfig memory cfg, uint8)
            {
                if (cfg.cooldownReduction >= effectiveCooldown)
                    effectiveCooldown = 0;
                else
                    effectiveCooldown -= cfg.cooldownReduction;
            } catch {}
        }

        uint48 last = lastClaimAt[user];

        if (last != 0 && nowTs < uint256(last) + effectiveCooldown)
            revert ClaimCooldownActive(user);

        /* ---------- PAYOUT ---------- */

        // Flush latest accrual (against current balance) into claimable.
        // Done after gates so a doomed call doesn't write state.
        _crystallise(user);

        claimed = claimable[user];
        if (claimed == 0) revert NothingToClaim();

        // Zero the accumulator. rewardDebt was already set to bal*acc by
        // _crystallise above, so any further accrual against the user's
        // current balance starts cleanly.
        claimable[user] = 0;

        lastClaimAt[user] = uint48(nowTs);

        totalClaimed += claimed;

        require(
            IERC20Like(address(mmm)).transfer(user, claimed),
            "TransferFailed"
        );
        // The transfer above will trigger MMMToken._update -> the hooks on
        // this contract, which resync rewardDebt to the user's NEW balance
        // (bal + claimed). No further bookkeeping needed here.

        emit Claimed(user, claimed);
    }

    /*//////////////////////////////////////////////////////////////
                        TOKEN-TRIGGERED HOOKS
    //////////////////////////////////////////////////////////////*/

    // Called by MMMToken BEFORE balances change. Crystallises whatever the
    // sender and receiver have earned against their CURRENT balances into
    // the claimable accumulator, so the upcoming balance change cannot
    // retro-grant or retro-strip rewards.
    function preTransferHook(address from, address to) external onlyToken {
        if (from != address(0)) _crystallise(from);
        if (to   != address(0) && to != from) _crystallise(to);
    }

    // Called by MMMToken AFTER balances change. Resyncs rewardDebt to the
    // post-transfer balance so future accrual is computed cleanly from the
    // new position.
    function postTransferHook(address from, address to) external onlyToken {
        if (from != address(0)) _resyncDebt(from);
        if (to   != address(0) && to != from) _resyncDebt(to);
    }

    function _crystallise(address user) internal {
        uint256 bal = mmm.balanceOf(user);
        uint256 accrued = (bal * accRewardPerToken) / ACC_SCALE;
        uint256 debt = rewardDebt[user];

        if (accrued > debt) {
            uint256 added = accrued - debt;
            claimable[user] += added;
            emit Crystallised(user, added, claimable[user]);
        }

        // Mark the user as fully settled against the current acc + bal.
        rewardDebt[user] = accrued;
    }

    function _resyncDebt(address user) internal {
        uint256 bal = mmm.balanceOf(user);
        rewardDebt[user] = (bal * accRewardPerToken) / ACC_SCALE;
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN SYNC
    //////////////////////////////////////////////////////////////*/

    function syncRewardDebt(address user)
        external
        onlyOwner
    {
        uint256 bal = mmm.balanceOf(user);
        rewardDebt[user] =
            (bal * accRewardPerToken) / ACC_SCALE;
    }
}
