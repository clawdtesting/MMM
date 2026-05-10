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

        // Initialize reward debt for existing holders to prevent retroactive claiming
        // This sets debt based on current accRewardPerToken (which starts at 0)
        // New users will get their debt initialized when they first receive tokens via the hook
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

        if (accrued <= debt) return 0;

        return accrued - debt;
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
        nonReentrant
    {
        // if (amount == 0) revert ZeroAmount();

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

        claimed = pending(user);
        if (claimed == 0) revert NothingToClaim();

        rewardDebt[user] =
            (bal * accRewardPerToken) / ACC_SCALE;

        lastClaimAt[user] = uint48(nowTs);

        totalClaimed += claimed;   // NEW

        require(
            IERC20Like(address(mmm)).transfer(user, claimed),
            "TransferFailed"
        );

        emit Claimed(user, claimed);
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

    // Hook for MMMToken to update reward debt on transfers
    function updateRewardDebt(address user) external {
        uint256 bal = mmm.balanceOf(user);
        rewardDebt[user] =
            (bal * accRewardPerToken) / ACC_SCALE;
    }
}
