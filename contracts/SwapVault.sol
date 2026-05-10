// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract SwapVault is Ownable {
    IERC20 public immutable mmm;

    constructor(address mmmToken, address initialOwner) Ownable(initialOwner) {
        require(mmmToken != address(0), "Zero address");
        mmm = IERC20(mmmToken);
    }

    // Simple function to receive and hold tokens (for testing)
    function deposit(uint256 amount) external {
        require(mmm.transferFrom(msg.sender, address(this), amount), "Transfer failed");
    }

    // Simple function to withdraw tokens (for testing)
    function withdraw(uint256 amount) external onlyOwner {
        require(mmm.transfer(owner(), amount), "Transfer failed");
    }

    function balance() external view returns (uint256) {
        return mmm.balanceOf(address(this));
    }
}