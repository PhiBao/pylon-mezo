// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Tigris (Mezo native DEX) interfaces used by Pylon
/// @notice Pylon sources flash liquidity from the volatile MUSD/BTC pool, which
///         performs the optimistic transfer then calls `IPoolCallee.hook` on the recipient.

interface IPool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function stable() external view returns (bool);

    function factory() external view returns (address);

    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IPoolCallee {
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface IPoolFactory {
    function getFee(address pool, bool stable) external view returns (uint256);

    function isPaused() external view returns (bool);

    function isPool(address pool) external view returns (bool);
}

interface IRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function defaultFactory() external view returns (address);

    function poolFor(address tokenA, address tokenB, bool stable, address factory) external view returns (address);

    function getReserves(address tokenA, address tokenB, bool stable, address factory) external view returns (uint256, uint256);

    function getAmountsOut(
        uint256 amountIn,
        Route[] memory routes
    ) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
