// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Router01} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router01.sol";
import {IUniswapV2Router02} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

contract MockRouter is IUniswapV2Router01, IUniswapV2Router02 {
    address public mmm;
    address public usdc;
    address public wmon;

    constructor(address _mmm, address _usdc, address _wmon) {
        mmm = _mmm;
        usdc = _usdc;
        wmon = _wmon;
    }

    // IUniswapV2Router01 functions
    function factory() external pure override returns (address) {
        return address(0x1);
    }

    function WETH() external pure override returns (address) {
        return address(0x2);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external override returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        return (amountADesired, amountBDesired, 0);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable override returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        return (amountTokenDesired, msg.value, 0);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external override returns (uint256 amountA, uint256 amountB) {
        return (0, 0);
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external override returns (uint256 amountToken, uint256 amountETH) {
        return (0, 0);
    }

    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external override returns (uint256 amountA, uint256 amountB) {
        return (0, 0);
    }

    function removeLiquidityETHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external override returns (uint256 amountToken, uint256 amountETH) {
        return (0, 0);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountInMax;
        }
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = msg.value;
        }
    }

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountInMax;
        }
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }

    function swapETHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = msg.value;
        }
    }

    function quote(
        uint256 amountA,
        uint256 reserveA,
        uint256 reserveB
    ) external pure override returns (uint256 amountB) {
        return amountA;
    }

    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) external pure override returns (uint256 amountOut) {
        return amountIn;
    }

    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) external pure override returns (uint256 amountIn) {
        return amountOut;
    }

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }

    function getAmountsIn(
        uint256 amountOut,
        address[] calldata path
    ) external view override returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountOut;
        }
    }

    // IUniswapV2Router02 additional functions
    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external override returns (uint256 amountETH) {
        return 0;
    }

    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external override returns (uint256 amountETH) {
        return 0;
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override {
        // Do nothing for mock
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable override {
        // Do nothing for mock
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override {
        // Do nothing for mock
    }
}