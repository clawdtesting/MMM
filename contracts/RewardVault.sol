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
    error NotAuthorized();
    error OnlyToken();
    error NotAContract(address who);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyToken() {
        if (msg.sender != address(mmm)) revert OnlyToken();
        _;
    }

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

    // Rewards captured on each transfer hook for the FROM/TO address,
    // representing accruals earned at the pre-transfer balance. These are
    // paid out alongside the live `pending()` on claim. Prevents new
    // holders from claiming retroactively and snipers from draining the
    // pool with a big buy + immediate claim.
    mapping(address => uint256) public creditedRewards;

    // Crystallised reward accumulator. Topped up by preTransferHook on
    // every transfer that touches `user`, drained by claim(). pending()
    // reads from this in addition to the live unclaimed-from-current
    // window so a partial-sell + future claim still pays out the rewards
    // earned at the prior (larger) balance.
    mapping(address => uint256) public claimable;

    // Carry-over from integer division in notifyRewardAmount so dust
    // amounts ((amount * ACC_SCALE) % eligibleSupply) roll into the next
    // distribution rather than getting silently discarded.
    uint256 public notifyRemainder;

    // Distribution kill switch. While disabled, notifyRewardAmount
    // reverts, but existing claimable + pending balances stay claimable.
    // Used to pause emissions during incident response without freezing
    // user funds that were already earned.
    bool public distributionsEnabled = true;

    /*//////////////////////////////////////////////////////////////
                        SUPPLY EXCLUSION
    //////////////////////////////////////////////////////////////*/

    address[] public excludedRewardAddresses;
    // O(1) mirror of excludedRewardAddresses for hot-path checks.
    mapping(address => bool) public isExcludedFromRewards;
    // Bounded number of excluded addresses to keep eligibleSupply gas O(1)
    // in the common case. Append-only governance pattern; raise if a new
    // exchange listing requires it.
    uint256 public constant MAX_EXCLUDED = 32;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BoostNFTSet(address indexed boostNFT);
    event Notified(uint256 amount, uint256 eligibleSupply, uint256 newAcc);
    event Claimed(address indexed user, uint256 amount);
    event Credited(address indexed user, uint256 amount);
    event Crystallised(address indexed user, uint256 added, uint256 newTotal);
    event DistributionsEnabledSet(bool enabled);

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
        // Reject EOAs / non-contract addresses for the token reference —
        // a typo here would silently brick claim() at runtime.
        if (_mmm.code.length == 0) revert NotAContract(_mmm);

        mmm = IMMMToken(_mmm);

        minHoldTimeSec = _minHoldTimeSec;
        claimCooldown  = _claimCooldown;
        minBalance     = _minBalance;

        // Exclude vault itself
        excludedRewardAddresses.push(address(this));
        isExcludedFromRewards[address(this)] = true;
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

        if (isExcludedFromRewards[user]) return 0;

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

    error TooManyExcluded();

    function addExcludedRewardAddress(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        if (isExcludedFromRewards[a]) return;
        if (excludedRewardAddresses.length >= MAX_EXCLUDED)
            revert TooManyExcluded();
        excludedRewardAddresses.push(a);
        isExcludedFromRewards[a] = true;
    }

    error DistributionsDisabled();

    function notifyRewardAmount(uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (!distributionsEnabled) revert DistributionsDisabled();
        if (amount == 0) revert ZeroAmount();

        uint256 denom = eligibleSupply();
        if (denom == 0) revert EligibleSupplyZero();

        // Carry over the previous remainder so dust never gets lost.
        uint256 numerator = amount * ACC_SCALE + notifyRemainder;
        accRewardPerToken += numerator / denom;
        notifyRemainder    = numerator % denom;

        totalDistributed  += amount;

        emit Notified(amount, denom, accRewardPerToken);
    }

    /// Pauses / unpauses notifyRewardAmount. Existing claimable + pending
    /// balances stay claimable while disabled — this is an emission kill
    /// switch, not a user-funds freeze.
    function setDistributionsEnabled(bool enabled) external onlyOwner {
        distributionsEnabled = enabled;
        emit DistributionsEnabledSet(enabled);
    }

    /*//////////////////////////////////////////////////////////////
                        TRANSFER HOOK (called by MMM)

       MMMToken._update calls this BEFORE each underlying super._update,
       so balanceOf(user) here is the PRE-transfer balance. We capture
       the rewards earned at the old balance into creditedRewards and
       reset rewardDebt to the new balance, so future emissions accrue
       only against the new balance. This kills both retroactive
       claiming for new holders and the snipe-then-claim attack.
    //////////////////////////////////////////////////////////////*/

    function syncOnTransfer(address from, address to, uint256 amount)
        external
    {
        if (msg.sender != address(mmm)) revert NotAuthorized();
        // Self-transfers leave balances unchanged; nothing to settle.
        if (amount == 0 || from == to) return;

        if (from != address(0)) {
            uint256 oldBal = mmm.balanceOf(from);
            uint256 newBal = oldBal > amount ? oldBal - amount : 0;
            _settle(from, oldBal, newBal);
        }
        if (to != address(0)) {
            uint256 oldBal = mmm.balanceOf(to);
            uint256 newBal = oldBal + amount;
            _settle(to, oldBal, newBal);
        }
    }

    function _settle(address user, uint256 oldBal, uint256 newBal) internal {
        if (isExcludedFromRewards[user]) return;

        // Credit rewards earned at the OLD balance, but only if the user
        // was at or above the participation minimum. This mirrors the
        // pending() semantics so a holder doesn't accidentally credit
        // anything from a sub-min position.
        if (oldBal >= minBalance) {
            uint256 accrued = (oldBal * accRewardPerToken) / ACC_SCALE;
            uint256 debt = rewardDebt[user];
            if (accrued > debt) {
                uint256 delta = accrued - debt;
                creditedRewards[user] += delta;
                emit Credited(user, delta);
            }
        }

        // Reset debt to the post-transfer balance so subsequent
        // accRewardPerToken increases accrue against the new position.
        rewardDebt[user] = (newBal * accRewardPerToken) / ACC_SCALE;
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

        if (isExcludedFromRewards[user]) revert NotAuthorized();

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

        uint256 livePending = pending(user);
        uint256 credit = creditedRewards[user];
        claimed = livePending + credit;
        if (claimed == 0) revert NothingToClaim();

        // CRITICAL: settle rewardDebt to the current balance before the
        // payout transfer. Otherwise the preTransferHook fired by mmm's
        // _update will see (accrued > debt) for the user's current
        // balance and re-credit `claimable[user]` with what we just
        // zeroed out — a one-shot double-spend.
        rewardDebt[user] = (bal * accRewardPerToken) / ACC_SCALE;

        claimable[user] = 0;

        if (credit > 0) creditedRewards[user] = 0;

        lastClaimAt[user] = uint48(nowTs);

        totalClaimed += claimed;

        require(
            IERC20Like(address(mmm)).transfer(user, claimed),
            "TransferFailed"
        );
        // The transfer above triggers MMMToken._update -> our hooks; the
        // postTransferHook will resync rewardDebt to (bal + claimed) * acc
        // so future accrual is computed cleanly from the new position.

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
        // Excluded addresses (rewardVault itself, taxVault, pair, DEAD)
        // never accrue, so skip them entirely. Otherwise pre-transfer
        // crystallise would silently fill `claimable` for addresses that
        // can't ever claim, distorting `totalDistributed` accounting.
        if (isExcludedFromRewards[user]) return;

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
        if (isExcludedFromRewards[user]) return;
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
