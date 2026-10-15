// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    IERC20,
    IMUSD,
    ITroveManager,
    IBorrowerOperations,
    IBorrowerOperationsSignatures,
    ISortedTroves,
    IHintHelpers,
    IPriceFeed
} from "./IMezo.sol";
import {IPool, IRouter} from "./ITigris.sol";

/// @notice Minimal view of the Pylon engine used by positions, the reserve and integrations.
interface IPylonEngine {
    function musd() external view returns (IMUSD);

    function btc() external view returns (IERC20);

    function flashPool() external view returns (IPool);

    function swapPool() external view returns (IPool);

    function flashMusdIsToken0() external view returns (bool);

    function router() external view returns (IRouter);

    function borrowerOps() external view returns (IBorrowerOperations);

    function borrowerOpsSignatures() external view returns (IBorrowerOperationsSignatures);

    function troveManager() external view returns (ITroveManager);

    function sortedTroves() external view returns (ISortedTroves);

    function hintHelpers() external view returns (IHintHelpers);

    function priceFeed() external view returns (IPriceFeed);

    function reserve() external view returns (address);

    function gasCompensation() external view returns (uint256);

    function minNetDebt() external view returns (uint256);

    function isPosition(address account) external view returns (bool);

    function flashFeeBps() external view returns (uint16);

    function musdIsToken0() external view returns (bool);
}
