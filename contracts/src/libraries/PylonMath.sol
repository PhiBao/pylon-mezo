// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title PylonMath
/// @notice Exact-input / exact-output math for constant-product (volatile) Tigris pools, plus
///         health-factor helpers expressed in wads (1e18). The Rust solver mirrors this file
///         one-to-one so quotes produced off-chain match what the contracts enforce on-chain.
library PylonMath {
    error ZeroAmount();
    error InsufficientLiquidity();
    error DivisionByZero();

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant NICR_PRECISION = 1e20;

    /// @notice Output of a volatile-pool swap for `amountIn`, fees raked from the input.
    /// @dev Mirrors Tigris Pool.getAmountOut: fee is taken off `amountIn` before the curve.
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feeBps
    ) internal pure returns (uint256) {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInAfterFee = (amountIn * (BPS - feeBps)) / BPS;
        return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
    }

    /// @notice Exact input required to receive `amountOut`, rounded up.
    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feeBps
    ) internal pure returns (uint256) {
        if (amountOut == 0) revert ZeroAmount();
        if (reserveOut <= amountOut) revert InsufficientLiquidity();
        // amountInAfterFee = out * reserveIn / (reserveOut - out)
        uint256 numerator = amountOut * reserveIn;
        uint256 denominator = reserveOut - amountOut;
        uint256 amountInAfterFee = (numerator + denominator - 1) / denominator; // round up
        // amountIn = amountInAfterFee * BPS / (BPS - feeBps)
        uint256 feeAdjusted = BPS - feeBps;
        return ((amountInAfterFee * BPS) + feeAdjusted - 1) / feeAdjusted; // round up
    }

    /// @notice Individual collateral ratio in wad from collateral (18 dec) and debt (18 dec).
    function collateralRatio(
        uint256 coll,
        uint256 debt,
        uint256 price
    ) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        return (coll * price) / debt;
    }

    /// @notice Debt level that brings `coll` to exactly `targetICR` (wad).
    function debtAtRatio(
        uint256 coll,
        uint256 price,
        uint256 targetICR
    ) internal pure returns (uint256) {
        if (targetICR == 0) revert DivisionByZero();
        return (coll * price * WAD) / (targetICR * WAD) / 1; // coll*price/targetICR
    }

    /// @notice Mezo nominal CR, matching HintHelpers.computeNominalCR.
    function nominalCR(uint256 coll, uint256 debt) internal pure returns (uint256) {
        if (debt == 0) revert DivisionByZero();
        return (coll * NICR_PRECISION) / debt;
    }

    /// @notice Leverage multiple implied by an ICR (debt/coll value = 1/ICR).
    function leverageFromICR(uint256 icr) internal pure returns (uint256) {
        if (icr == 0) revert DivisionByZero();
        return (type(uint256).max == icr) ? 0 : (WAD * WAD) / icr;
    }
}
