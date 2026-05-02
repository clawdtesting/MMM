// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintable {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
}

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// Minimal Uniswap V2-compatible router used by unit tests.
/// Pulls tokenIn from the caller and mints tokenOut to the recipient at a
/// 1:1 underlying-value rate, scaled for decimal differences. The mock
/// must own (or be authorized to mint) any tokenOut it produces.
contract MockRouter {
    address public immutable mmm;
    address public immutable wmon;
    address public immutable usdc;

    constructor(address mmm_, address wmon_, address usdc_) {
        mmm = mmm_;
        wmon = wmon_;
        usdc = usdc_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 /*amountOutMin*/,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockRouter: bad path");

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        require(
            IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "MockRouter: transferIn failed"
        );

        uint8 decIn = IERC20Like(tokenIn).decimals();
        uint8 decOut = IERC20Like(tokenOut).decimals();

        uint256 amountOut;
        if (decOut >= decIn) {
            amountOut = amountIn * (10 ** uint256(decOut - decIn));
        } else {
            amountOut = amountIn / (10 ** uint256(decIn - decOut));
        }

        IMintable(tokenOut).mint(to, amountOut);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }

    /// Optional pre-funding helper used by the testnet seed script.
    function fund(address token, uint256 amount) external {
        require(
            IERC20Like(token).transferFrom(msg.sender, address(this), amount),
            "MockRouter: fund failed"
        );
    }
}
