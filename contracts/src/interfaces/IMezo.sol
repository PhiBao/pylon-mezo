// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Mezo protocol interfaces used by Pylon
/// @notice Only the surface Pylon actually calls. Addresses are configured per network
///         (see script/Deploy.s.sol and deployments/*.json).

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function decimals() external view returns (uint8);
}

interface IMUSD is IERC20 {
    function mint(address account, uint256 amount) external;

    function burn(address account, uint256 amount) external;
}

interface ITroveManager {
    enum Status {
        nonExistent,
        active,
        closedByOwner,
        closedByLiquidation,
        closedByRedemption
    }

    function getTroveStatus(address borrower) external view returns (Status);

    function getTroveColl(address borrower) external view returns (uint256);

    function getTroveDebt(address borrower) external view returns (uint256);

    function getTrovePrincipal(address borrower) external view returns (uint256);

    function getTroveInterestOwed(address borrower) external view returns (uint256);

    function getTroveInterestRate(address borrower) external view returns (uint16);

    function getTroveLastInterestUpdateTime(address borrower) external view returns (uint256);

    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);

    function getNominalICR(address borrower) external view returns (uint256);

    function getEntireDebtAndColl(
        address borrower
    )
        external
        view
        returns (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingCollateral,
            uint256 pendingPrincipal,
            uint256 pendingInterest
        );

    function getTCR(uint256 price) external view returns (uint256);

    function checkRecoveryMode(uint256 price) external view returns (bool);

    function updateSystemInterest() external;

    function updateSystemAndTroveInterest(address borrower) external;

    function MCR() external view returns (uint256);

    function CCR() external view returns (uint256);
}

interface IBorrowerOperations {
    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;

    function addColl(address upperHint, address lowerHint) external payable;

    function withdrawColl(uint256 amount, address upperHint, address lowerHint) external;

    function withdrawMUSD(uint256 amount, address upperHint, address lowerHint) external;

    function repayMUSD(uint256 amount, address upperHint, address lowerHint) external;

    function adjustTrove(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint
    ) external payable;

    function closeTrove() external;

    function refinance(address upperHint, address lowerHint) external;

    function claimCollateral() external;

    function getBorrowingFee(uint256 debt) external view returns (uint256);

    function minNetDebt() external view returns (uint256);

    function MUSD_GAS_COMPENSATION() external view returns (uint256);
}

interface IBorrowerOperationsSignatures {
    function getNonce(address user) external view returns (uint256);

    function openTroveWithSignature(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    function adjustTroveWithSignature(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    function withdrawCollWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external;

    function withdrawMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external;

    function repayMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes calldata signature,
        uint256 deadline
    ) external;

    function closeTroveWithSignature(
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external;
}

interface ISortedTroves {
    function contains(address id) external view returns (bool);

    function getSize() external view returns (uint256);

    function getFirst() external view returns (address);

    function getLast() external view returns (address);

    function getNext(address id) external view returns (address);

    function getPrev(address id) external view returns (address);

    function validInsertPosition(
        uint256 nicr,
        address prevId,
        address nextId
    ) external view returns (bool);

    function findInsertPosition(
        uint256 nicr,
        address prevId,
        address nextId
    ) external view returns (address, address);
}

interface IHintHelpers {
    function getApproxHint(
        uint256 cr,
        uint256 numTrials,
        uint256 inputRandomSeed
    ) external view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed);

    function computeNominalCR(uint256 coll, uint256 debt) external pure returns (uint256);

    function computeCR(
        uint256 coll,
        uint256 debt,
        uint256 price
    ) external pure returns (uint256);
}

interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}
