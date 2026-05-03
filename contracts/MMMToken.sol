// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IRewardVaultHook {
    function preTransferHook(address from, address to) external;
    function postTransferHook(address from, address to) external;
}

contract MMMToken is ERC20, Ownable {

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error TaxVaultAlreadySet();
    error RewardVaultAlreadySet();
    error AlreadyLaunched();
    error TradingNotEnabled();

    /*//////////////////////////////////////////////////////////////
                                CONFIG
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS = 10_000;

    address public taxVault;
    bool public taxVaultSetOnce;

    address public rewardVault;
    bool public rewardVaultSetOnce;

    address public pair;
    address public router;

    bool public tradingEnabled;
    bool public launched;
    uint256 public launchTime;

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

    /// @notice One-time wiring of the RewardVault. Once set, MMMToken will
    /// invoke the reward sync hooks on every transfer to keep rewardDebt
    /// in sync with each user's balance — preventing retroactive reward
    /// claims by new buyers (issues.txt #5 and #7).
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
                        LAST NON ZERO TRACKING
    //////////////////////////////////////////////////////////////*/

    function _syncLastNonZero(address a) internal {
        if (a == address(0)) return;

        uint256 bal = balanceOf(a);

        if (bal == 0) {
            lastNonZeroAt[a] = 0;
        } else if (lastNonZeroAt[a] == 0) {
            lastNonZeroAt[a] = block.timestamp;
        }
    }

    /*//////////////////////////////////////////////////////////////
                        TRANSFER LOGIC
    //////////////////////////////////////////////////////////////*/

    function _update(address from, address to, uint256 amount) internal override {
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
            super._update(from, to, amount);
            _syncLastNonZero(from);
            _syncLastNonZero(to);
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
            super._update(from, to, amount);
            _syncLastNonZero(from);
            _syncLastNonZero(to);
            return;
        }

        uint256 taxBps = isBuyTx
            ? getBuyTaxBps()
            : getSellTaxBps();

        if (taxBps == 0) {
            super._update(from, to, amount);
            _syncLastNonZero(from);
            _syncLastNonZero(to);
            return;
        }

        uint256 tax = (amount * taxBps) / BPS;

        // ------------------------------------------------------------
        // BUY (pair → buyer)
        // CRITICAL: DO NOT reduce amount leaving pair
        // ------------------------------------------------------------
        if (isBuyTx) {
            // 1️⃣ Pair sends full amount to buyer
            super._update(from, to, amount);

            // 2️⃣ Buyer pays tax to vault
            super._update(to, taxVault, tax);

            _syncLastNonZero(to);
            _syncLastNonZero(taxVault);
            return;
        }

        // ------------------------------------------------------------
        // SELL (seller → pair)
        // ------------------------------------------------------------
        if (isSellTx) {
            // Seller pays tax
            super._update(from, taxVault, tax);

            // Net goes to pair
            super._update(from, to, amount - tax);

            _syncLastNonZero(from);
            _syncLastNonZero(taxVault);
            return;
        }

        // Fallback (should never hit for AMM)
        super._update(from, to, amount);
        _syncLastNonZero(from);
        _syncLastNonZero(to);
    }
}
