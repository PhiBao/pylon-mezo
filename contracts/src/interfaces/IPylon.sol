// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Pylon-side interfaces (engine <-> positions <-> reserve)

interface IPylonReserve {
    function notifyFee(uint256 amount) external;

    function lendTo(uint256 amount) external;

    function recordRepayment(uint256 amount) external;

    function availableToLend(address position) external view returns (uint256);

    function registerPosition(address position) external;

    function totalAssets() external view returns (uint256);

    function loans(address position) external view returns (uint256);
}

interface IPylonPosition {
    function initialize(address owner_, address engine_) external;

    function owner() external view returns (address);

    function engine() external view returns (address);

    function reserve() external view returns (address);

    function canExecute(address account) external view returns (bool);

    function reserveDebt() external view returns (uint256);

    function executeTroveAdjust(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint
    ) external payable;

    function executeClose() external;
}
