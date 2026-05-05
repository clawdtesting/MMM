// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/*//////////////////////////////////////////////////////////////
                        ROUTER INTERFACE
//////////////////////////////////////////////////////////////*/

interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint[] memory amounts);
}

/*//////////////////////////////////////////////////////////////
                    REWARD VAULT INTERFACE
//////////////////////////////////////////////////////////////*/

interface IRewardVault {
    function notifyRewardAmount(uint256 amount) external;
}

interface IRewardVaultAdmin {
    function addExcludedRewardAddress(address a) external;
}

/*//////////////////////////////////////////////////////////////
                            TAX VAULT
//////////////////////////////////////////////////////////////*/

contract TaxVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error NotAContract(address who);
    error NotWired();
    error RouterMissing();
    error AmountZero();
    error ProcessingDisabled();
    error TooSoon();
    error BelowThreshold();
    error InsufficientBalance();

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /*//////////////////////////////////////////////////////////////
                                TOKENS
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable mmm;
    IERC20 public immutable usdc;
    IERC20 public immutable wmon;

    /*//////////////////////////////////////////////////////////////
                                WIRING
    //////////////////////////////////////////////////////////////*/

    address public rewardVault;
    address public marketingVault;
    address public teamVestingVault;

    /*//////////////////////////////////////////////////////////////
                                ROUTER / KEEPER
    //////////////////////////////////////////////////////////////*/

    address public router;
    address public keeper;

    bool public processingEnabled = true;

    /*//////////////////////////////////////////////////////////////
                                KEEPER CONFIG
    //////////////////////////////////////////////////////////////*/

    uint256 public minProcessAmount = 5_000 ether;
    uint256 public minProcessInterval = 5 minutes;
    uint256 public lastProcessTime;

    /*//////////////////////////////////////////////////////////////
                                SPLITS
    //////////////////////////////////////////////////////////////*/

    uint16 public bpsReward = 4000; // 40%
    uint16 public bpsBurn   = 1000; // 10%
    uint16 public bpsMkt    = 700;  // 70% of USDC
    uint16 public bpsTeam   = 300;  // 30% of USDC

    bool public useDirectUsdcPath = true;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Processed(
        uint256 mmmIn,
        uint256 mmmToReward,
        uint256 mmmToBurn,
        uint256 mmmSwapped,
        uint256 usdcOut,
        uint256 usdcToMkt,
        uint256 usdcToTeam
    );

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address mmmToken,
        address usdcToken,
        address wmonToken,
        address initialOwner
    ) Ownable(initialOwner) {
        if (
            mmmToken == address(0) ||
            usdcToken == address(0) ||
            wmonToken == address(0) ||
            initialOwner == address(0)
        ) revert ZeroAddress();
        // Reject EOAs / non-contract addresses for the three token
        // references — a typo would silently brick process() at runtime
        // (the contract would deploy fine but every swap would revert).
        if (mmmToken.code.length == 0) revert NotAContract(mmmToken);
        if (usdcToken.code.length == 0) revert NotAContract(usdcToken);
        if (wmonToken.code.length == 0) revert NotAContract(wmonToken);

        mmm = IERC20(mmmToken);
        usdc = IERC20(usdcToken);
        wmon = IERC20(wmonToken);
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    function setRouter(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        router = r;
    }

    function approveRouter() external onlyOwner {
        if (router == address(0)) revert RouterMissing();
        mmm.forceApprove(router, type(uint256).max);
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
    }

    function setProcessingEnabled(bool v) external onlyOwner {
        processingEnabled = v;
    }

    function setProcessConfig(
        uint256 minAmount,
        uint256 minInterval
    ) external onlyOwner {
        minProcessAmount = minAmount;
        minProcessInterval = minInterval;
    }

    function wireOnce(
        address rewardVault_,
        address marketingVault_,
        address teamVestingVault_
    ) external onlyOwner {
        if (
            rewardVault_ == address(0) ||
            marketingVault_ == address(0) ||
            teamVestingVault_ == address(0)
        ) revert ZeroAddress();

        rewardVault = rewardVault_;
        marketingVault = marketingVault_;
        teamVestingVault = teamVestingVault_;
    }

    function excludeFromRewards(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        IRewardVaultAdmin(rewardVault).addExcludedRewardAddress(a);
    }

    /*//////////////////////////////////////////////////////////////
                        KEEPER ENTRYPOINT
    //////////////////////////////////////////////////////////////*/

    function processTaxes() external nonReentrant {
        if (!processingEnabled) revert ProcessingDisabled();

        if (
            block.timestamp < lastProcessTime + minProcessInterval
        ) revert TooSoon();

        uint256 balance = mmm.balanceOf(address(this));

        if (balance < minProcessAmount)
            revert BelowThreshold();

        lastProcessTime = block.timestamp;

        _process(balance, 0, block.timestamp + 5 minutes);
    }

    /*//////////////////////////////////////////////////////////////
                        MANUAL OVERRIDE
    //////////////////////////////////////////////////////////////*/

    function process(
        uint256 mmmAmount,
        uint256 minUsdcOut,
        uint256 deadline
    ) external nonReentrant {
        if (!processingEnabled) revert ProcessingDisabled();
        if (mmmAmount == 0) revert AmountZero();
        if (block.timestamp > deadline) revert TooSoon();

        uint256 balance = mmm.balanceOf(address(this));
        if (balance < mmmAmount)
            revert InsufficientBalance();

        lastProcessTime = block.timestamp;

        _process(mmmAmount, minUsdcOut, deadline);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL PROCESS LOGIC
    //////////////////////////////////////////////////////////////*/

    function _process(
        uint256 mmmAmount,
        uint256 minUsdcOut,
        uint256 deadline
    ) internal {

        if (
            rewardVault == address(0) ||
            marketingVault == address(0) ||
            teamVestingVault == address(0)
        ) revert NotWired();

        uint256 toReward = (mmmAmount * bpsReward) / BPS;
        uint256 toBurn   = (mmmAmount * bpsBurn) / BPS;
        uint256 toSwap   = mmmAmount - toReward - toBurn;

        if (toBurn > 0)
            mmm.safeTransfer(DEAD, toBurn);

        if (toReward > 0) {
            mmm.safeTransfer(rewardVault, toReward);
            IRewardVault(rewardVault).notifyRewardAmount(toReward);
        }

        uint256 usdcOut = 0;

        if (toSwap > 0) {
            if (router == address(0)) revert RouterMissing();

            address[] memory path;

            if (useDirectUsdcPath) {
                path = new address[](2);
                path[0] = address(mmm);
                path[1] = address(usdc);
            } else {
                path = new address[](3);
                path[0] = address(mmm);
                path[1] = address(wmon);
                path[2] = address(usdc);
            }

            uint256 balBefore = usdc.balanceOf(address(this));

            IUniswapV2Router02(router).swapExactTokensForTokens(
                toSwap,
                minUsdcOut,
                path,
                address(this),
                deadline
            );

            usdcOut = usdc.balanceOf(address(this)) - balBefore;
        }

        uint256 denom = uint256(bpsMkt) + uint256(bpsTeam);

        uint256 toMkt  = denom == 0 ? 0 : (usdcOut * bpsMkt) / denom;
        uint256 toTeam = usdcOut - toMkt;

        if (toMkt  > 0) usdc.safeTransfer(marketingVault, toMkt);
        if (toTeam > 0) usdc.safeTransfer(teamVestingVault, toTeam);

        emit Processed(
            mmmAmount,
            toReward,
            toBurn,
            toSwap,
            usdcOut,
            toMkt,
            toTeam
        );
    }
}