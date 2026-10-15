// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {PylonFlashEngine} from "../src/PylonFlashEngine.sol";
import {PylonPosition} from "../src/PylonPosition.sol";
import {PylonReserve} from "../src/PylonReserve.sol";
import {IMUSD, IERC20, ITroveManager, IBorrowerOperations, IBorrowerOperationsSignatures, ISortedTroves, IHintHelpers, IPriceFeed} from "../src/interfaces/IMezo.sol";
import {IPool, IPoolFactory, IRouter} from "../src/interfaces/ITigris.sol";
import {PylonMath} from "../src/libraries/PylonMath.sol";

/// @title Prove
/// @notice Executes the real Pylon flows on Mezo Testnet against live MUSD/BTC pools and prints
///         explorer-verifiable transaction hashes. Each phase is idempotent-ish and driven by env:
///
///   PHASE=1  open the operator's native Mezo trove (collateral + MUSD debt)
///   PHASE=2  seed the shield reserve with borrowed MUSD (reserve becomes a real lender)
///   PHASE=3  flash loop the native trove (EIP-712 signed, no up-front MUSD)
///   PHASE=4  flash unwind the native trove (repay debt from its own collateral, 0 wallet MUSD)
///   PHASE=5  flash close the native trove (full exit funded by collateral)
///   PHASE=6  create a Pylon position, open its trove, configure the shield
///   PHASE=7  run the permissionless shield defence from reserve capital
///   PHASE=8  flash loop a Pylon position (keeper/executor path)
contract Prove is Script {
    PylonFlashEngine engine;
    PylonPosition positionImpl;
    PylonReserve reserve;
    IMUSD musd;
    IERC20 btc;
    ITroveManager troveManager;
    IBorrowerOperations borrowerOps;
    IBorrowerOperationsSignatures borrowerOpsSig;
    ISortedTroves sortedTroves;
    IHintHelpers hintHelpers;
    IPriceFeed priceFeed;

    uint256 pk;
    address operator;

    function setUp() public {
        pk = vm.envUint("PRIVATE_KEY");
        operator = vm.addr(pk);

        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        engine = PylonFlashEngine(payable(vm.parseJsonAddress(json, ".pylonFlashEngine")));
        reserve = PylonReserve(payable(vm.parseJsonAddress(json, ".pylonReserve")));
        positionImpl = PylonPosition(payable(vm.parseJsonAddress(json, ".pylonPositionImplementation")));
        musd = IMUSD(vm.parseJsonAddress(json, ".musd"));
        btc = IERC20(vm.parseJsonAddress(json, ".btc"));
        troveManager = ITroveManager(vm.parseJsonAddress(json, ".troveManager"));
        borrowerOps = IBorrowerOperations(vm.parseJsonAddress(json, ".borrowerOps"));
        borrowerOpsSig = IBorrowerOperationsSignatures(vm.parseJsonAddress(json, ".borrowerOpsSignatures"));
        sortedTroves = ISortedTroves(vm.parseJsonAddress(json, ".sortedTroves"));
        hintHelpers = IHintHelpers(vm.parseJsonAddress(json, ".hintHelpers"));
        priceFeed = IPriceFeed(vm.parseJsonAddress(json, ".priceFeed"));

        // The Mezo BTC oracle is a native precompile that cannot execute inside a forked EVM, so the
        // local run mocks it with the live price. Calldata — and therefore on-chain behaviour — is
        // unaffected: the real precompile answers when the transaction is mined.
        uint256 price = _price();
        vm.mockCall(
            address(0x7b7c000000000000000000000000000000000015),
            abi.encodeWithSignature("decimals()"),
            abi.encode(uint8(18))
        );
        vm.mockCall(
            address(0x7b7c000000000000000000000000000000000015),
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(price), block.timestamp, block.timestamp, uint80(0))
        );
    }

    // ---------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------

    function run() external {
        uint256 phase = vm.envUint("PHASE");
        console.log("== Pylon proof ==");
        console.log("phase", phase);
        console.log("operator", operator);
        console.log("sorted troves", sortedTroves.getSize());

        if (phase == 1) return _openNativeTrove();
        if (phase == 2) return _seedReserve();
        if (phase == 3) return _loopNative();
        if (phase == 4) return _unwindNative();
        if (phase == 5) return _closeNative();
        if (phase == 6) return _createPositionAndOpen();
        if (phase == 7) return _defendPosition();
        if (phase == 8) return _loopPosition();
        revert("unknown phase");
    }

    // ---------------------------------------------------------------------
    // Phase 1: open the operator's native trove
    // ---------------------------------------------------------------------

    function _openNativeTrove() internal {
        uint256 coll = vm.envOr("COLL", uint256(0.045e18));
        uint256 debt = vm.envOr("DEBT", uint256(1_800e18));

        (address upper, address lower) = _hints(coll, debt + 200e18 + borrowerOps.getBorrowingFee(debt));

        vm.startBroadcast(pk);
        borrowerOps.openTrove{value: coll}(debt, upper, lower);
        vm.stopBroadcast();

        console.log("trove collateral", troveManager.getTroveColl(operator));
        console.log("trove debt", troveManager.getTroveDebt(operator));
        console.log("musd balance", musd.balanceOf(operator));
        console.log("icr (wad)", _icr(operator));
    }

    // ---------------------------------------------------------------------
    // Phase 2: seed the shield reserve
    // ---------------------------------------------------------------------

    function _seedReserve() internal {
        uint256 amount = vm.envOr("SEED", uint256(1_000e18));
        vm.startBroadcast(pk);
        musd.approve(address(reserve), amount);
        reserve.deposit(amount, operator);
        vm.stopBroadcast();
        console.log("reserve totalAssets", reserve.totalAssets());
        console.log("reserve idle", reserve.idleLiquidity());
    }

    // ---------------------------------------------------------------------
    // Phase 3: flash loop the native trove (signed)
    // ---------------------------------------------------------------------

    function _loopNative() internal {
        uint256 collAdd = vm.envOr("COLL_ADD", uint256(0.005e18));
        (uint256 debtDelta, uint256 pylonFee) = engine.previewLoopDebtForCollateral(collAdd);
        uint256 nonce = borrowerOpsSig.getNonce(operator);
        uint256 deadline = block.timestamp + 30 minutes;

        console.log("loop: collAdd", collAdd);
        console.log("loop: debtDelta", debtDelta);
        console.log("loop: pylonFee", pylonFee);
        console.log("loop: nonce", nonce);

        bytes memory sig = _signAdjustTrove(0, debtDelta, true, collAdd, operator, address(engine), nonce, deadline);

        vm.startBroadcast(pk);
        (uint256 btcOut, uint256 fee) = engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: operator,
                debtAmount: debtDelta,
                collAdd: collAdd,
                outputTo: operator,
                minPostICR: vm.envOr("MIN_POST_ICR", uint256(0)),
                deadline: deadline,
                upperHint: address(0),
                lowerHint: address(0),
                signature: sig
            })
        );
        vm.stopBroadcast();

        console.log("loop btcOut", btcOut);
        console.log("loop fee", fee);
        console.log("trove collateral", troveManager.getTroveColl(operator));
        console.log("trove debt", troveManager.getTroveDebt(operator));
        console.log("icr (wad)", _icr(operator));
    }

    // ---------------------------------------------------------------------
    // Phase 4: flash unwind (repay from collateral, zero wallet MUSD)
    // ---------------------------------------------------------------------

    function _unwindNative() internal {
        uint256 repay = vm.envOr("REPAY", uint256(400e18));
        uint256 btcNeeded = engine.previewUnwindBtcIn(repay);
        uint256 collOut = btcNeeded + (btcNeeded / 20); // 5% headroom over the required sale

        uint256 nonce = borrowerOpsSig.getNonce(operator);
        uint256 deadline = block.timestamp + 30 minutes;

        console.log("unwind: repay", repay);
        console.log("unwind: btcNeeded", btcNeeded);
        console.log("unwind: collOut", collOut);
        console.log("unwind: wallet musd before", musd.balanceOf(operator));

        bytes memory sig = _signAdjustTrove(collOut, repay, false, 0, operator, address(engine), nonce, deadline);

        vm.startBroadcast(pk);
        (uint256 musdOut, uint256 btcBack) = engine.unwindSigned(
            PylonFlashEngine.UnwindRequest({
                owner: operator,
                repayAmount: repay,
                collOut: collOut,
                outputTo: operator,
                minPostICR: vm.envOr("MIN_POST_ICR", uint256(0)),
                deadline: deadline,
                upperHint: address(0),
                lowerHint: address(0),
                signature: sig
            })
        );
        vm.stopBroadcast();

        console.log("unwind musdOut", musdOut);
        console.log("unwind btcBack", btcBack);
        console.log("trove collateral", troveManager.getTroveColl(operator));
        console.log("trove debt", troveManager.getTroveDebt(operator));
        console.log("icr (wad)", _icr(operator));
    }

    // ---------------------------------------------------------------------
    // Phase 5: flash close (signed)
    // ---------------------------------------------------------------------

    function _closeNative() internal {
        uint256 nonce = borrowerOpsSig.getNonce(operator);
        uint256 deadline = block.timestamp + 30 minutes;
        console.log("close: nonce", nonce);

        bytes memory sig = _signCloseTrove(operator, address(engine), nonce, deadline);

        vm.startBroadcast(pk);
        (uint256 btcToOwner, uint256 fee) = engine.closeSigned(
            PylonFlashEngine.CloseRequest({
                owner: operator,
                outputTo: operator,
                deadline: deadline,
                signature: sig
            })
        );
        vm.stopBroadcast();

        console.log("close btcToOwner", btcToOwner);
        console.log("close fee", fee);
        console.log("trove status", uint8(troveManager.getTroveStatus(operator)));
        console.log("wallet btc", btc.balanceOf(operator));
        console.log("wallet musd", musd.balanceOf(operator));
    }

    // ---------------------------------------------------------------------
    // Phase 6: position + shield configuration
    // ---------------------------------------------------------------------

    function _createPositionAndOpen() internal {
        uint256 coll = vm.envOr("COLL", uint256(0.03e18));
        uint256 debt = vm.envOr("DEBT", uint256(1_800e18));

        address existing = vm.envOr("POSITION", address(0));
        address position = existing;

        vm.startBroadcast(pk);
        if (position == address(0)) {
            position = engine.createPosition(operator);
        }
        PylonPosition(payable(position)).openTrove{value: coll}(debt);
        PylonPosition(payable(position)).setShield(
            true,
            uint64(vm.envOr("TRIGGER_ICR", uint256(2.2e18))),
            uint64(vm.envOr("TARGET_ICR", uint256(2.6e18))),
            uint128(vm.envOr("MAX_PER_CALL", uint256(500e18)))
        );
        vm.stopBroadcast();

        uint256 collNow = troveManager.getTroveColl(position);
        uint256 debtNow = troveManager.getTroveDebt(position);
        console.log("position", position);
        console.log("position coll", collNow);
        console.log("position debt", debtNow);
        console.log("position icr (wad)", troveManager.getCurrentICR(position, _price()));
        console.log("positions are registered:", engine.isPosition(position));
    }

    // ---------------------------------------------------------------------
    // Phase 7: permissionless defence from reserve capital
    // ---------------------------------------------------------------------

    function _defendPosition() internal {
        address position = vm.envAddress("POSITION");
        uint256 icrBefore = troveManager.getCurrentICR(position, _price());
        uint256 available = reserve.availableToLend(position);
        console.log("defend: icr before", icrBefore);
        console.log("defend: reserve available", available);

        vm.startBroadcast(pk);
        uint256 repaid = PylonPosition(payable(position)).defend();
        vm.stopBroadcast();

        uint256 debtAfter = troveManager.getTroveDebt(position);
        uint256 icrAfter = troveManager.getCurrentICR(position, _price());
        console.log("defend: repaid", repaid);
        console.log("defend: debt after", debtAfter);
        console.log("defend: icr after", icrAfter);
        console.log("defend: reserve claim", PylonPosition(payable(position)).reserveDebt());
    }

    // ---------------------------------------------------------------------
    // Phase 8: flash loop a position (executor path)
    // ---------------------------------------------------------------------

    function _loopPosition() internal {
        address position = vm.envAddress("POSITION");
        uint256 collAdd = vm.envOr("COLL_ADD", uint256(0.002e18));
        (uint256 debtDelta, ) = engine.previewLoopDebtForCollateral(collAdd);

        console.log("position loop: debtDelta", debtDelta);
        vm.startBroadcast(pk);
        engine.loopPosition(position, debtDelta, collAdd, address(0), address(0), vm.envOr("MIN_POST_ICR", uint256(0)), block.timestamp + 30 minutes);
        vm.stopBroadcast();

        console.log("position debt after", troveManager.getTroveDebt(position));
        console.log("position icr after", troveManager.getCurrentICR(position, _price()));
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev The Mezo BTC oracle is a precompile that cannot be executed inside a forked EVM, so
    ///      scripts take the price from the environment (read with `cast call` beforehand).
    function _price() internal view returns (uint256) {
        return vm.envOr("PRICE", uint256(82_480e18));
    }

    function _icr(address who) internal view returns (uint256) {
        return troveManager.getCurrentICR(who, _price());
    }

    function _hints(uint256 coll, uint256 debt) internal view returns (address upper, address lower) {
        uint256 nicr = PylonMath.nominalCR(coll, debt);
        (address approx, , ) = hintHelpers.getApproxHint(nicr, 40, uint256(keccak256(abi.encodePacked(block.number))));
        (upper, lower) = sortedTroves.findInsertPosition(nicr, approx, approx);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                address(borrowerOpsSig)
            )
        );
    }

    function _signAdjustTrove(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        uint256 assetAmount,
        address borrower,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "AdjustTrove(uint256 collWithdrawal,uint256 debtChange,bool isDebtIncrease,uint256 assetAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
                ),
                collWithdrawal,
                debtChange,
                isDebtIncrease,
                assetAmount,
                borrower,
                recipient,
                nonce,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _signCloseTrove(
        address borrower,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CloseTrove(address borrower,address recipient,uint256 nonce,uint256 deadline)"),
                borrower,
                recipient,
                nonce,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }
}
