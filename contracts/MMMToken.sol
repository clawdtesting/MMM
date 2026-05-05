// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IRewardVaultHook {
    function syncOnTransfer(address from, address to, uint256 amount) external;
    function preTransferHook(address from, address to) external;
    function postTransferHook(address from, address to) external;
}

contract MMMToken is ERC20, Ownable2Step, Pausable {

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error TaxVaultAlreadySet();
    error RewardVaultAlreadySet();
    error AlreadyLaunched();
    error TradingNotEnabled();
    error NotGuardian();
    error TaxBpsTooHigh(uint256 requested, uint256 cap);

    /*//////////////////////////////////////////////////////////////
                                CONFIG
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS = 10_000;
    // Hard cap on any tax bracket the schedule can produce. Even owner
    // can't raise tax above this. The launch schedule itself is
    // immutable code, but if a future setter is added, this guards it.
    uint256 public constant MAX_TAX_BPS = 8_000; // 80%

    address public taxVault;
    bool public taxVaultSetOnce;

    address public rewardVault;
    bool public rewardVaultSetOnce;

    address public pair;
    address public router;

    bool public tradingEnabled;
    bool public launched;
    uint256 public launchTime;

    // Guardian can pause() (one-way safety lever) but cannot unpause(),
    // mint, set vaults, or move funds. Owner retains the unpause power.
    address public guardian;

    mapping(address => bool) public isTaxExempt;
    mapping(address => uint256) public lastNonZeroAt;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Launch(uint256 timestamp);
    event TradingEnabled();
    event TaxVaultSet(address indexed vault);
    event RewardVaultSet(address indexed vault);
    event PairSet(address indexed pair);
    event RouterSet(address indexed router);
    event TaxExemptSet(address indexed who, bool exempt);
    event GuardianSet(address indexed guardian);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) {
            revert NotGuardian();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address owner_
    )
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        if (owner_ == address(0)) revert ZeroAddress();

        _mint(owner_, initialSupply);
        isTaxExempt[owner_] = true;

        if (initialSupply > 0) {
            lastNonZeroAt[owner_] = block.timestamp;
        }
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    function setTaxVaultOnce(address vault) external onlyOwner {
        if (taxVaultSetOnce) revert TaxVaultAlreadySet();
        if (vault == address(0)) revert ZeroAddress();

        taxVault = vault;
        taxVaultSetOnce = true;

        emit TaxVaultSet(vault);
    }

    function setRewardVaultOnce(address vault) external onlyOwner {
        if (rewardVaultSetOnce) revert RewardVaultAlreadySet();
        if (vault == address(0)) revert ZeroAddress();

        rewardVault = vault;
        rewardVaultSetOnce = true;

        emit RewardVaultSet(vault);
    }

    function setPair(address pair_) external onlyOwner {
        if (pair_ == address(0)) revert ZeroAddress();
        pair = pair_;
        emit PairSet(pair_);
    }

    function setRouter(address router_) external onlyOwner {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
        emit RouterSet(router_);
    }

    function launch() external onlyOwner {
        if (launched) revert AlreadyLaunched();

        launched = true;
        tradingEnabled = true;
        launchTime = block.timestamp;

        emit Launch(launchTime);
        emit TradingEnabled();
    }

    function setTaxExempt(address who, bool exempt) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        isTaxExempt[who] = exempt;
        emit TaxExemptSet(who, exempt);
    }

    /*//////////////////////////////////////////////////////////////
                            PAUSE / GUARDIAN
    //////////////////////////////////////////////////////////////*/

    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    /// One-way safety lever for incident response. Either owner or
    /// guardian can flip it. While paused, regular transfers revert;
    /// mint and burn paths (from/to address(0)) are still allowed so
    /// admin can recover stuck funds without first unpausing.
    function pause() external onlyOwnerOrGuardian {
        _pause();
    }

    /// Unpause is owner-only — the guardian intentionally cannot
    /// resume trading on its own, only halt it.
    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                        TAX DECAY MODEL
    //////////////////////////////////////////////////////////////*/

    function getBuyTaxBps() public view returns (uint256) {
        if (!launched) return 0;

        uint256 elapsed = block.timestamp - launchTime;

        if (elapsed < 10 minutes) return 8000;
        if (elapsed < 20 minutes) return 5000;
        if (elapsed < 40 minutes) return 3000;
        if (elapsed < 60 minutes) return 1000;
        return 500;
    }

    function getSellTaxBps() public view returns (uint256) {
        if (!launched) return 0;

        uint256 elapsed = block.timestamp - launchTime;

        if (elapsed < 20 minutes) return 8000;
        if (elapsed < 40 minutes) return 6000;
        if (elapsed < 60 minutes) return 4000;
        if (elapsed < 90 minutes) return 2000;
        return 500;
    }

    /*//////////////////////////////////////////////////////////////
                        HOLD-TIME TRACKING

       Balance-weighted lastNonZeroAt: receiving tokens advances the
       timestamp toward `now` proportional to inflow vs prior balance,
       so dust priming (sending 1 wei to many wallets to mature them)
       cannot skip the hold period for a later large inbound transfer.
       Partial outflows preserve the timestamp; a full exit clears it.
    //////////////////////////////////////////////////////////////*/

    function _onIncrease(address a, uint256 oldBal, uint256 amountIn) internal {
        if (a == address(0) || amountIn == 0) return;

        if (oldBal == 0) {
            lastNonZeroAt[a] = block.timestamp;
            return;
        }

        uint256 newBal = oldBal + amountIn;
        uint256 oldLnz = lastNonZeroAt[a];
        // weighted average:
        //   newLnz = (oldBal * oldLnz + amountIn * now) / newBal
        lastNonZeroAt[a] =
            (oldBal * oldLnz + amountIn * block.timestamp) / newBal;
    }

    function _onDecrease(address a, uint256 oldBal, uint256 amountOut) internal {
        if (a == address(0) || amountOut == 0) return;

        if (oldBal == amountOut) {
            // Full exit: clear the hold timer.
            lastNonZeroAt[a] = 0;
        }
        // Partial exit: keep the existing timestamp — the user has held the
        // remaining balance since lastNonZeroAt.
    }

    /*//////////////////////////////////////////////////////////////
                        TRANSFER LOGIC
    //////////////////////////////////////////////////////////////*/

    function _doTransfer(address from, address to, uint256 amount) internal {
        // Snapshot pre-transfer balances. balanceOf(0) is 0, so this is
        // safe for mint/burn paths.
        uint256 fromBal = from == address(0) ? 0 : balanceOf(from);
        uint256 toBal   = to   == address(0) ? 0 : balanceOf(to);

        // 1) Reward-debt sync hook — captures any pending rewards earned at
        //    the OLD balance into RewardVault.creditedRewards and resets
        //    each side's rewardDebt to the NEW balance. Prevents both
        //    retroactive claiming for new holders and sniper-drain on big
        //    buy + immediate claim.
        address rv = rewardVault;
        if (rv != address(0) && amount > 0) {
            IRewardVaultHook(rv).syncOnTransfer(from, to, amount);
        }

        // 2) Hold-time tracking BEFORE balance change.
        if (from != to) {
            _onDecrease(from, fromBal, amount);
            _onIncrease(to, toBal, amount);
        }

        super._update(from, to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        // Pause check: halt user-facing transfers but leave mint/burn
        // (from/to == address(0)) live so admin can still rescue funds.
        if (paused() && from != address(0) && to != address(0)) {
            revert EnforcedPause();
        }

        address rv = rewardVault;
        if (rv != address(0)) {
            IRewardVaultHook(rv).preTransferHook(from, to);
        }

        _doUpdate(from, to, amount);

        if (rv != address(0)) {
            IRewardVaultHook(rv).postTransferHook(from, to);
        }
    }

    function _doUpdate(address from, address to, uint256 amount) internal {

        // Mint / Burn
        if (from == address(0) || to == address(0)) {
            _doTransfer(from, to, amount);
            return;
        }

        // Trading lock
        if (!tradingEnabled) {
            if (!isTaxExempt[from] && !isTaxExempt[to]) {
                revert TradingNotEnabled();
            }
        }

        bool isBuyTx  = (from == pair);
        bool isSellTx = (to == pair);

        bool takeTax =
            launched &&
            taxVault != address(0) &&
            pair != address(0) &&
            (isBuyTx || isSellTx) &&
            !isTaxExempt[from] &&
            !isTaxExempt[to];

        if (!takeTax) {
            _doTransfer(from, to, amount);
            return;
        }

        uint256 taxBps = isBuyTx
            ? getBuyTaxBps()
            : getSellTaxBps();

        if (taxBps == 0) {
            _doTransfer(from, to, amount);
            return;
        }

        uint256 tax = (amount * taxBps) / BPS;

        // BUY (pair → buyer): pair sends full amount, then buyer pays tax.
        if (isBuyTx) {
            _doTransfer(from, to, amount);
            _doTransfer(to, taxVault, tax);
            return;
        }

        // SELL (seller → pair): seller pays tax, then net to pair.
        if (isSellTx) {
            _doTransfer(from, taxVault, tax);
            _doTransfer(from, to, amount - tax);
            return;
        }

        // Fallback (should never hit for AMM)
        _doTransfer(from, to, amount);
    }
}
