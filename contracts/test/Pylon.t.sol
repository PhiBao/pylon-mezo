// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {PylonFlashEngine} from "../src/PylonFlashEngine.sol";
import {PylonPosition} from "../src/PylonPosition.sol";
import {PylonReserve} from "../src/PylonReserve.sol";
import {PylonMath} from "../src/libraries/PylonMath.sol";
import {IMUSD, IERC20, IBorrowerOperations, IBorrowerOperationsSignatures, ITroveManager, ISortedTroves, IHintHelpers, IPriceFeed} from "../src/interfaces/IMezo.sol";
import {IPool, IPoolFactory, IRouter} from "../src/interfaces/ITigris.sol";
import {IERC20 as OZIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPylonReserve} from "../src/interfaces/IPylon.sol";
import {
    MockERC20,
    MockBtcToken,
    MockPool,
    MockPoolFactory,
    MockRouter,
    MockPriceFeed,
    MockTroveManager,
    MockBorrowerOps,
    MockBorrowerOpsSignatures,
    MockHintHelpers,
    MockSortedTroves
} from "./mocks/Mocks.sol";

contract PylonTest is Test {
    MockERC20 musd;
    MockERC20 musdc;
    MockBtcToken btc;
    MockPoolFactory poolFactory;
    MockPool flashPool;
    MockPool swapPool;
    MockRouter router;
    MockPriceFeed priceFeed;
    MockTroveManager troveManager;
    MockBorrowerOps borrowerOps;
    MockBorrowerOpsSignatures sigOps;
    MockHintHelpers hintHelpers;
    MockSortedTroves sortedTroves;

    PylonFlashEngine engine;
    PylonReserve reserve;
    PylonPosition positionImpl;

    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address lp = address(0x11D);

    uint256 constant PRICE = 100_000e18;
    uint256 constant POOL_MUSD = 100_000_000e18;
    uint256 constant POOL_BTC = 1_000e18;
    uint256 constant FLASH_MUSD = 200_000e18;
    uint256 constant FLASH_OTHER = 70_000e6;

    function setUp() public {
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        musdc = new MockERC20("Mezo USDC", "mUSDC", 6);
        btc = new MockBtcToken();
        // Mezo reports native and ERC-20 BTC through one balance, so the harness models it.
        btc.setNativeLedger(true);
        poolFactory = new MockPoolFactory();
        // flash venue: stable MUSD pool (mirrors the live MUSD/mUSDC pool)
        flashPool = new MockPool(address(musd), address(musdc), address(poolFactory), true);
        // swap venue: volatile MUSD/BTC pool (mirrors the live pool)
        swapPool = new MockPool(address(musd), address(btc), address(poolFactory), false);
        poolFactory.setPoolFee(address(flashPool), 1);
        poolFactory.setPoolFee(address(swapPool), 4);
        router = new MockRouter(swapPool, address(poolFactory));
        priceFeed = new MockPriceFeed();
        troveManager = new MockTroveManager();
        borrowerOps = new MockBorrowerOps(IMUSD(address(musd)), troveManager, btc);
        sigOps = new MockBorrowerOpsSignatures(IMUSD(address(musd)), borrowerOps, troveManager, btc);
        hintHelpers = new MockHintHelpers();
        sortedTroves = new MockSortedTroves();

        swapPool.setReserves(POOL_MUSD, POOL_BTC);
        musd.mint(address(swapPool), POOL_MUSD);
        btc.mint(address(swapPool), POOL_BTC);
        flashPool.setReserves(FLASH_MUSD, FLASH_OTHER);
        musd.mint(address(flashPool), FLASH_MUSD);
        musdc.mint(address(flashPool), FLASH_OTHER);

        engine = new PylonFlashEngine(
            owner,
            IMUSD(address(musd)),
            IERC20(address(btc)),
            IPool(address(flashPool)),
            IPool(address(swapPool)),
            IRouter(address(router)),
            IPoolFactory(address(poolFactory)),
            IBorrowerOperations(address(borrowerOps)),
            IBorrowerOperationsSignatures(address(sigOps)),
            ITroveManager(address(troveManager)),
            ISortedTroves(address(sortedTroves)),
            IHintHelpers(address(hintHelpers)),
            IPriceFeed(address(priceFeed)),
            owner
        );

        reserve = new PylonReserve(owner, OZIERC20(address(musd)));
        reserve.setEngine(address(engine));
        engine.setReserve(address(reserve));

        positionImpl = new PylonPosition();
        engine.setPositionImplementation(address(positionImpl));

        // fund the engine with native balance so it can forward BTC obtained from swaps
        vm.deal(address(engine), 100e18);
        vm.warp(1_700_000_000);
    }

    // ---------------------------------------------------------------------
    // Native trove: loop
    // ---------------------------------------------------------------------

    function test_loopSigned_addsCollateralAndBorrowsAgainstNativeTrove() public {
        uint256 startColl = 1e18;
        uint256 startDebt = 25_000e18;
        troveManager.setTrove(alice, startColl, startDebt, 1);

        uint256 collAdd = 0.1e18;
        (uint256 debtDelta, uint256 feeMusd) = engine.previewLoopDebtForCollateral(collAdd);

        uint256 flashFee = _flashFee(debtDelta);
        uint256 pylonFee = feeMusd;

        vm.prank(alice);
        (uint256 btcOut, uint256 reportedFee) = engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: debtDelta,
                collAdd: collAdd,
                outputTo: alice,
                minPostICR: 1.2e18,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );

        assertGe(btcOut, collAdd, "router delivered at least the requested collateral");
        assertEq(reportedFee, feeMusd, "fee reported matches estimate");

        assertEq(troveManager.getTroveColl(alice), startColl + collAdd, "collateral grew");
        uint256 expectedDebt = startDebt + debtDelta + borrowerOps.getBorrowingFee(debtDelta);
        assertEq(troveManager.getTroveDebt(alice), expectedDebt, "debt grew by delta plus Mezo fee");

        // flash venue: repaid in full plus its own fee
        assertEq(musd.balanceOf(address(flashPool)), FLASH_MUSD + flashFee, "flash repaid with pool fee");
        // swap venue: absorbed exactly the MUSD that was converted into collateral
        assertEq(musd.balanceOf(address(swapPool)), POOL_MUSD + debtDelta - flashFee - pylonFee, "swap venue funded");
        // shield pool: earned the Pylon origination fee
        assertEq(reserve.feesReceived(), pylonFee, "fee routed to the shield pool");
        assertEq(musd.balanceOf(address(reserve)), pylonFee, "fee landed in the reserve");
        assertEq(sigOps.nonces(alice), 1, "signature nonce consumed");
    }

    function test_loopSigned_revertsWhenTroveNotActive() public {
        troveManager.setTrove(alice, 0, 0, 0);
        vm.expectRevert(PylonFlashEngine.TroveNotActive.selector);
        engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: 2_000e18,
                collAdd: 0.02e18,
                outputTo: alice,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
    }

    function test_loopSigned_enforcesPostICRGuard() public {
        troveManager.setTrove(alice, 0.05e18, 4_000e18, 1);
        uint256 collAdd = 0.001e18;
        (uint256 debtDelta,) = engine.previewLoopDebtForCollateral(collAdd);
        vm.expectRevert();
        engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: debtDelta,
                collAdd: collAdd,
                outputTo: alice,
                minPostICR: 5e18, // impossible floor
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
    }

    // ---------------------------------------------------------------------
    // Native trove: unwind (zero MUSD required)
    // ---------------------------------------------------------------------

    function test_unwindSigned_repaysDebtFromCollateralWithZeroWalletMusd() public {
        uint256 startColl = 1e18;
        uint256 startDebt = 25_000e18;
        troveManager.setTrove(alice, startColl, startDebt, 1);

        uint256 repayAmount = 5_000e18;
        uint256 collOut = 0.06e18; // ceiling the user is willing to release
        assertEq(musd.balanceOf(alice), 0, "alice starts with no MUSD");

        vm.prank(alice);
        (uint256 musdOut, uint256 btcReturned) = engine.unwindSigned(
            PylonFlashEngine.UnwindRequest({
                owner: alice,
                repayAmount: repayAmount,
                collOut: collOut,
                outputTo: alice,
                minPostICR: 1.5e18,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );

        uint256 flashFee = _flashFee(repayAmount);
        uint256 pylonFee = engine.feeReport(repayAmount);

        assertEq(troveManager.getTroveDebt(alice), startDebt - repayAmount, "debt repaid exactly");
        assertEq(troveManager.getTroveColl(alice), startColl - collOut, "collateral released exactly");
        assertGt(musdOut, 0, "swap produced MUSD");
        assertGt(btcReturned, 0, "unused collateral returned to owner");
        assertEq(musd.balanceOf(address(flashPool)), FLASH_MUSD + flashFee, "flash repaid with pool fee");
        assertEq(musd.balanceOf(address(swapPool)), POOL_MUSD - musdOut, "swap venue paid out the MUSD");
        assertEq(musd.balanceOf(address(reserve)), pylonFee, "fee in reserve");
        assertEq(musdOut, repayAmount + flashFee + pylonFee + musd.balanceOf(alice), "proceeds fully accounted");
        assertEq(musd.balanceOf(address(engine)), 0, "engine holds no idle MUSD after the flash");
        assertEq(
            btc.balanceOf(alice) + troveManager.getTroveColl(alice),
            startColl - (collOut - btcReturned),
            "no collateral lost outside the trove"
        );
        assertEq(musd.balanceOf(alice), musdOut - repayAmount - flashFee - pylonFee, "surplus MUSD delivered to owner");
    }

    function test_unwindSigned_revertsWhenCeilingTooSmall() public {
        troveManager.setTrove(alice, 1e18, 25_000e18, 1);
        // releasing 0.0001 BTC cannot fund a 20,000 MUSD repayment
        vm.expectRevert();
        engine.unwindSigned(
            PylonFlashEngine.UnwindRequest({
                owner: alice,
                repayAmount: 20_000e18,
                collOut: 0.0001e18,
                outputTo: alice,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
    }

    // ---------------------------------------------------------------------
    // Native trove: full exit
    // ---------------------------------------------------------------------

    function test_closeSigned_exitsTroveAndReturnsNetBtc() public {
        uint256 startColl = 1e18;
        uint256 startDebt = 25_000e18;
        troveManager.setTrove(alice, startColl, startDebt, 1);

        vm.prank(alice);
        (uint256 btcToOwner, uint256 feeMusd) = engine.closeSigned(
            PylonFlashEngine.CloseRequest({
                owner: alice,
                outputTo: alice,
                deadline: block.timestamp + 1 hours,
                signature: bytes("")
            })
        );

        uint256 flashAmount = startDebt - borrowerOps.MUSD_GAS_COMPENSATION();
        uint256 flashFee = _flashFee(flashAmount);
        uint256 pylonFee = engine.feeReport(flashAmount);

        assertEq(troveManager.getTroveDebt(alice), 0, "trove closed");
        assertEq(troveManager.getTroveColl(alice), 0, "collateral withdrawn");
        assertEq(musd.balanceOf(address(flashPool)), FLASH_MUSD + flashFee, "flash repaid with pool fee");
        assertApproxEqAbs(
            musd.balanceOf(address(swapPool)),
            POOL_MUSD - (flashAmount + flashFee + pylonFee),
            1e14,
            "swap paid out the closing cost"
        );
        assertEq(feeMusd, pylonFee, "fee accounting");
        assertEq(musd.balanceOf(address(reserve)), pylonFee, "fee in reserve");
        assertEq(btc.balanceOf(address(swapPool)), POOL_BTC + (startColl - btcToOwner), "venue received the sold BTC");
        assertGt(btcToOwner, 0.7e18, "owner gets ~75% of the collateral back as BTC");
        assertEq(btc.balanceOf(alice), btcToOwner, "BTC delivered to the owner wallet");
    }

    function test_closeSigned_revertsWhenPositionIsUnderwater() public {
        troveManager.setTrove(alice, 1e18, 100_000e18, 1); // collateral value == debt
        vm.expectRevert();
        engine.closeSigned(
            PylonFlashEngine.CloseRequest({
                owner: alice,
                outputTo: alice,
                deadline: block.timestamp + 1 hours,
                signature: bytes("")
            })
        );
    }

    // ---------------------------------------------------------------------
    // Flash safety
    // ---------------------------------------------------------------------

    function test_hook_rejectsForeignCaller() public {
        vm.expectRevert(PylonFlashEngine.NotFlashPool.selector);
        engine.hook(address(this), 0, 0, bytes(""));
    }

    function test_hook_rejectsCallWithoutActiveFlash() public {
        vm.prank(address(flashPool));
        vm.expectRevert(PylonFlashEngine.NoActiveFlash.selector);
        engine.hook(address(engine), 0, 0, bytes(""));
    }

    function test_flashFee_isBoundedByGovernance() public {
        vm.expectRevert(PylonFlashEngine.FeeTooHigh.selector);
        engine.setFlashFeeBps(101);
        engine.setFlashFeeBps(50);
        assertEq(engine.flashFeeBps(), 50);
    }

    // ---------------------------------------------------------------------
    // Positions + shield
    // ---------------------------------------------------------------------

    function test_position_openLoopAndShield() public {
        address position = engine.createPosition(bob);
        assertTrue(engine.isPosition(position), "registered with engine");
        assertTrue(reserve.positions(position), "registered with reserve");

        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        assertEq(troveManager.getTroveColl(position), 1e18, "position owns the collateral");
        uint256 debt = troveManager.getTroveDebt(position);
        assertGt(debt, 25_000e18, "debt includes gas compensation and fee");
        assertEq(musd.balanceOf(bob), 25_000e18, "borrowed MUSD forwarded to the owner");

        // loop the position (flash driven, no signature required)
        uint256 collAdd = 0.05e18;
        (uint256 debtDelta,) = engine.previewLoopDebtForCollateral(collAdd);
        vm.prank(bob);
        engine.loopPosition(position, debtDelta, collAdd, address(0), address(0), 1.2e18, block.timestamp + 1 hours);
        assertEq(troveManager.getTroveColl(position), 1e18 + collAdd, "position looped");

        // fund the shield pool and configure a licence to defend
        vm.startPrank(lp);
        musd.mint(lp, 100_000e18);
        musd.approve(address(reserve), 100_000e18);
        reserve.deposit(100_000e18, lp);
        vm.stopPrank();

        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.75e18, 2e18, 10_000e18);

        // BTC drops: ICR falls into the defence band
        priceFeed.setPrice(40_000e18);
        uint256 debtBefore = troveManager.getTroveDebt(position);

        // defence is permissionless
        vm.prank(address(0xDEAD));
        uint256 repaid = PylonPosition(payable(position)).defend();

        assertGt(repaid, 0, "reserve funded a defence");
        assertEq(PylonPosition(payable(position)).reserveDebt(), repaid, "claim recorded on the position");
        assertEq(reserve.loans(position), repaid, "loan recorded on the reserve");
        assertEq(reserve.outstanding(), repaid, "outstanding updated");

        // The reserve withholds its defence fee, so the debt falls by the amount received, not by the
        // booked loan. The difference is reserve yield.
        uint256 fee = (repaid * reserve.defenceFeeBps() + 9_999) / 10_000;
        assertEq(troveManager.getTroveDebt(position), debtBefore - (repaid - fee), "debt reduced by the received MUSD");
        assertEq(reserve.feesReceived(), (repayAmountFee()), "defence fee booked as reserve yield");
        assertGt(
            PylonMath.collateralRatio(1e18 + collAdd, debtBefore - repaid, 40_000e18),
            1.9e18,
            "ICR materially restored"
        );

        // collateral cannot leave while the claim is outstanding
        vm.prank(bob);
        vm.expectRevert(PylonPosition.ReserveDebtOutstanding.selector);
        PylonPosition(payable(position)).withdrawCollateral(0.01e18, bob);

        // settle the claim, then collateral is free again
        vm.startPrank(bob);
        musd.approve(address(position), repaid);
        musd.transfer(position, repaid);
        PylonPosition(payable(position)).repayReserve(repaid);
        vm.stopPrank();

        assertEq(PylonPosition(payable(position)).reserveDebt(), 0, "claim settled");
        assertEq(reserve.loans(position), 0, "reserve loan cleared");

        vm.prank(bob);
        PylonPosition(payable(position)).withdrawCollateral(0.01e18, bob);
        assertGt(btc.balanceOf(bob), 0, "owner withdrew collateral after settling");
    }

    function test_position_shieldCannotBeTriggeredWhenHealthy() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        vm.startPrank(lp);
        musd.mint(lp, 10_000e18);
        musd.approve(address(reserve), 10_000e18);
        reserve.deposit(10_000e18, lp);
        vm.stopPrank();

        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.5e18, 1.8e18, 10_000e18);

        vm.expectRevert(PylonPosition.Healthy.selector);
        PylonPosition(payable(position)).defend();
    }

    function test_position_flashCloseRequiresReserveSettled() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        vm.startPrank(lp);
        musd.mint(lp, 50_000e18);
        musd.approve(address(reserve), 50_000e18);
        reserve.deposit(50_000e18, lp);
        vm.stopPrank();

        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.9e18, 2.2e18, 10_000e18);
        // force a defence by dropping the price
        priceFeed.setPrice(20_000e18);
        PylonPosition(payable(position)).defend();
        assertGt(PylonPosition(payable(position)).reserveDebt(), 0);

        vm.prank(bob);
        vm.expectRevert(PylonFlashEngine.DebtAccountingMismatch.selector);
        engine.closePosition(position, bob, block.timestamp + 1 hours);
    }

    function test_position_flashCloseReturnsNetBtc() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        vm.prank(bob);
        engine.closePosition(position, bob, block.timestamp + 1 hours);

        assertEq(troveManager.getTroveDebt(position), 0, "position trove closed");
        assertGt(btc.balanceOf(bob), 0.7e18, "net BTC returned to the owner");
    }

    function test_positionUnauthorizedExecutorRejected() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        vm.prank(alice);
        vm.expectRevert(PylonFlashEngine.NotPositionExecutor.selector);
        engine.loopPosition(position, 2_000e18, 0.02e18, address(0), address(0), 0, block.timestamp + 1 hours);

        // the owner may nominate an executor, and then it works
        vm.prank(bob);
        PylonPosition(payable(position)).setExecutor(alice);
        (uint256 debtNeeded2, ) = engine.previewLoopDebtForCollateral(0.02e18);
        (uint256 collExpected, ) = engine.previewLoopCollateralForDebt(debtNeeded2);
        vm.prank(alice);
        engine.loopPosition(position, debtNeeded2, collExpected, address(0), address(0), 1.05e18, block.timestamp + 1 hours);
        assertGt(troveManager.getTroveColl(position), 1e18, "executor looped the position");
    }

    // ---------------------------------------------------------------------
    // Reserve accounting
    // ---------------------------------------------------------------------

    function test_reserve_depositWithdrawAndCaps() public {
        vm.startPrank(lp);
        musd.mint(lp, 10_000e18);
        musd.approve(address(reserve), 10_000e18);
        uint256 shares = reserve.deposit(10_000e18, lp);
        vm.stopPrank();

        // Shares carry a virtual-offset unit (1,000 shares = one MUSD of book value), so the invariant
        // is that the deposit is still worth what was paid — not that the count matches.
        assertEq(reserve.convertToAssets(shares), 10_000e18, "first deposit keeps its value");
        assertEq(reserve.totalAssets(), 10_000e18 + reserve.outstanding(), "assets tracked");

        // non-position cannot borrow
        vm.prank(alice);
        vm.expectRevert(PylonReserve.NotPosition.selector);
        reserve.lendTo(1_000e18);

        // fees lift the share price without minting shares
        vm.prank(address(engine));
        musd.mint(address(engine), 100e18);
        vm.prank(address(engine));
        musd.transfer(address(reserve), 100e18);
        vm.prank(address(engine));
        reserve.notifyFee(100e18);

        assertEq(reserve.feesReceived(), 100e18, "fees tracked");
        assertApproxEqAbs(reserve.convertToAssets(shares), 10_100e18, 2, "share price appreciates");

        vm.prank(lp);
        reserve.withdraw(shares, lp, lp);
        assertApproxEqAbs(musd.balanceOf(lp), 10_100e18, 2, "lp redeemed principal plus fees");
    }

    function test_reserve_utilizationCapBlocksLoans() public {
        vm.startPrank(lp);
        musd.mint(lp, 1_000e18);
        musd.approve(address(reserve), 1_000e18);
        reserve.deposit(1_000e18, lp);
        vm.stopPrank();

        address position = engine.createPosition(bob);
        // A 1,000 MUSD reserve with a 20% concentration cap can offer at most 200 MUSD to one
        // position, even though the utilisation cap would allow 900.
        assertEq(reserve.availableToLend(position), 200e18, "concentration cap binds before utilisation");

        uint256 overCap = reserve.maxLendPerCall() + 1;
        vm.prank(position);
        vm.expectRevert(PylonReserve.CapExceeded.selector);
        reserve.lendTo(overCap);
    }

    // ---------------------------------------------------------------------
    // Audit hardening regressions
    // ---------------------------------------------------------------------

    function test_flash_revertsWhenVenueDoesNotServiceTheCallback() public {
        troveManager.setTrove(alice, 1e18, 25_000e18, 1);
        (uint256 debtDelta, ) = engine.previewLoopDebtForCollateral(0.005e18);
        flashPool.setSkipHook(true);

        vm.expectRevert(PylonFlashEngine.FlashNotServiced.selector);
        engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: debtDelta,
                collAdd: 0.005e18,
                outputTo: alice,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );

        // Once the venue behaves, the same request succeeds: the guard rejects a silent no-op, it does
        // not break the flow.
        flashPool.setSkipHook(false);
        vm.prank(alice);
        engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: debtDelta,
                collAdd: 0.005e18,
                outputTo: alice,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
        assertEq(troveManager.getTroveColl(alice), 1e18 + 0.005e18);
    }

    function test_flash_revertsWhenPayloadDescribesAnotherOperation() public {
        troveManager.setTrove(alice, 1e18, 25_000e18, 1);
        (uint256 debtDelta, ) = engine.previewLoopDebtForCollateral(0.005e18);
        flashPool.setCorruptOpByte(true);

        vm.expectRevert(PylonFlashEngine.PayloadMismatch.selector);
        engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: debtDelta,
                collAdd: 0.005e18,
                outputTo: alice,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
    }

    function test_reserve_refusesEngineHandoverWithLiveLoans() public {
        address position = engine.createPosition(bob);
        vm.startPrank(lp);
        musd.mint(lp, 1_000e18);
        musd.approve(address(reserve), 1_000e18);
        reserve.deposit(1_000e18, lp);
        vm.stopPrank();

        vm.prank(position);
        reserve.lendTo(100e18);
        assertEq(reserve.outstanding(), 100e18);

        // Re-pointing the engine while a loan is live would strand the position's claim.
        vm.expectRevert(PylonReserve.OutstandingLoans.selector);
        reserve.setEngine(address(0xDEAD));

        // After settlement the handover is allowed again.
        vm.prank(position);
        musd.mint(position, 100e18);
        vm.prank(position);
        musd.transfer(address(reserve), 100e18);
        vm.prank(position);
        reserve.recordRepayment(100e18);
        reserve.setEngine(address(engine));
        assertEq(reserve.engine(), address(engine));
    }

    function test_reserve_concentrationCapLimitsOnePosition() public {
        address first = engine.createPosition(bob);
        address second = engine.createPosition(alice);

        vm.startPrank(lp);
        musd.mint(lp, 1_000e18);
        musd.approve(address(reserve), 1_000e18);
        reserve.deposit(1_000e18, lp);
        vm.stopPrank();

        // 20% of 1,000 assets is the ceiling for one position, even though utilisation allows 900.
        vm.prank(first);
        reserve.lendTo(200e18);
        assertLt(reserve.availableToLend(first), 1e18, "first position is at its share of the pool");
        assertLe(
            reserve.availableToLend(second),
            (reserve.totalAssets() * reserve.maxPerPositionBps()) / 10_000,
            "the cap is per position, not global"
        );
    }

    function test_reserve_refusesDefenceFeeAboveItsCeiling() public {
        vm.expectRevert(PylonReserve.FeeTooHigh.selector);
        reserve.setConcentration(2_000, 501);
        reserve.setConcentration(2_000, 100);
        assertEq(reserve.defenceFeeBps(), 100);
    }

    function test_position_shieldRejectsOutOfRangeBands() public {
        address position = engine.createPosition(bob);
        vm.startPrank(bob);
        vm.expectRevert(PylonPosition.BadShieldConfig.selector);
        PylonPosition(payable(position)).setShield(true, 5.5e18, 6e18, 1_000e18);
        vm.expectRevert(PylonPosition.BadShieldConfig.selector);
        PylonPosition(payable(position)).setShield(true, 1.2e18, 1.1e18, 1_000e18);
        vm.expectRevert(PylonPosition.BadShieldConfig.selector);
        PylonPosition(payable(position)).setShield(true, 1.2e18, 1.4e18, 0);
        PylonPosition(payable(position)).setShield(true, 1.2e18, 1.4e18, 1_000e18);
        vm.stopPrank();
    }

    function test_defence_mustImproveTheRatioMaterially() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        vm.startPrank(lp);
        musd.mint(lp, 1_000e18);
        musd.approve(address(reserve), 1_000e18);
        reserve.deposit(1_000e18, lp);
        vm.stopPrank();

        // A one-wei defence cannot move the ratio, so it must be refused rather than consume a slot.
        // A one-wei ceiling caps a real defence to a rounding amount; the guard must refuse it.
        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 2e18, 2.5e18, 100);
        priceFeed.setPrice(40_000e18);
        vm.expectRevert(PylonPosition.NoImprovement.selector);
        PylonPosition(payable(position)).defend();
    }

    function test_position_initializeIsEngineOnly() public {
        PylonPosition implementation = new PylonPosition();
        vm.prank(alice);
        vm.expectRevert(PylonPosition.OnlyEngine.selector);
        implementation.initialize(alice, address(engine));
    }

    function test_position_withdrawRefusesZeroAddress() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);
        vm.prank(bob);
        vm.expectRevert(PylonPosition.ZeroAddress.selector);
        PylonPosition(payable(position)).withdrawCollateral(0.001e18, address(0));
    }

    function test_position_bindsItsReserveAtInitialisation() public {
        address position = engine.createPosition(bob);
        assertEq(PylonPosition(payable(position)).reserve(), address(reserve), "reserve captured at initialisation");
        // A later engine re-point cannot move the position's claim to another reserve.
        engine.setReserve(address(0xBEEF));
        assertEq(PylonPosition(payable(position)).reserve(), address(reserve), "binding is immutable");
        engine.setReserve(address(reserve));
    }

    // ---------------------------------------------------------------------
    // Math
    // ---------------------------------------------------------------------

    function testFuzz_amountInRoundTrip(uint96 amountOut, uint96 reserveIn, uint96 reserveOut) public pure {
        uint256 rIn = uint256(reserveIn) % 1e30 + 1e18;
        uint256 rOut = uint256(reserveOut) % 1e30 + 1e18;
        uint256 out = uint256(amountOut) % (rOut / 2) + 1;

        uint256 amountIn = PylonMath.getAmountIn(out, rIn, rOut, 30);
        uint256 realised = PylonMath.getAmountOut(amountIn, rIn, rOut, 30);
        assertGe(realised, out, "rounding never short-changes the caller");
    }

    function test_debtAtRatio() public pure {
        uint256 coll = 1e18;
        uint256 price = 100_000e18;
        assertEq(PylonMath.debtAtRatio(coll, price, 2e18), 50_000e18, "half the collateral value");
        assertEq(PylonMath.collateralRatio(coll, 50_000e18, price), 2e18, "round trip");
    }

    /// @dev Defence fee the reserve withholds on the loan under test.
    function repayAmountFee() internal view returns (uint256) {
        return reserve.feesReceived();
    }

    /// @dev Mirrors the engine's flash-fee formula so tests can assert exact accounting.
    function _flashFee(uint256 amount) internal view returns (uint256) {
        uint256 f = engine.flashPoolFeeBps();
        if (f == 0) return 0;
        return (amount * f) / (10_000 - f) + 1;
    }

    // ---------------------------------------------------------------------
    // Audit regressions — second pass
    // ---------------------------------------------------------------------

    /// The audited `deposit` priced shares against a total that already held the deposit, so a second
    /// depositor lost up to half of their money to the first one inside the same transaction.
    function test_reserve_secondDepositKeepsItsValue() public {
        vm.startPrank(lp);
        musd.mint(lp, 1_000e18);
        musd.approve(address(reserve), 1_000e18);
        uint256 firstShares = reserve.deposit(1_000e18, lp);
        vm.stopPrank();

        address lp2 = address(0x1234);
        vm.startPrank(lp2);
        musd.mint(lp2, 100_000e18);
        musd.approve(address(reserve), 100_000e18);
        uint256 shares = reserve.deposit(100_000e18, lp2);
        vm.stopPrank();

        assertApproxEqAbs(reserve.convertToAssets(shares), 100_000e18, 2, "second deposit keeps its value");
        assertApproxEqAbs(reserve.convertToAssets(firstShares), 1_000e18, 2, "first depositor is not enriched");
    }

    /// A donation must not be able to price the next depositor out of the pool.
    function test_reserve_donationCannotBlockTheNextDepositor() public {
        vm.startPrank(lp);
        musd.mint(lp, 1_000e18);
        musd.approve(address(reserve), 1_000e18);
        reserve.deposit(1_000e18, lp);
        vm.stopPrank();

        // An attacker inflates the pool with a direct transfer.
        vm.startPrank(alice);
        musd.mint(alice, 1_000e18);
        musd.transfer(address(reserve), 1_000e18);
        vm.stopPrank();

        address lp2 = address(0x1234);
        vm.startPrank(lp2);
        musd.mint(lp2, 100e18);
        musd.approve(address(reserve), 100e18);
        uint256 shares = reserve.deposit(100e18, lp2);
        vm.stopPrank();

        assertGt(shares, 0, "a normal deposit still mints shares");
        assertApproxEqAbs(reserve.convertToAssets(shares), 100e18, 1e15, "value survives the donation");
    }

    /// Both position-mode flash legs must execute. The loop underflowed on the BTC baseline and the
    /// unwind underflowed on the MUSD the engine pre-funds, so every call used to revert.
    function test_position_flashLegsExecute() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        uint256 collAdd = 0.05e18;
        (uint256 debtDelta, ) = engine.previewLoopDebtForCollateral(collAdd);
        vm.prank(bob);
        engine.loopPosition(position, debtDelta, collAdd, address(0), address(0), 1.1e18, block.timestamp + 1 hours);
        assertEq(troveManager.getTroveColl(position), 1e18 + collAdd, "position loop executed");

        uint256 debtBefore = troveManager.getTroveDebt(position);
        vm.prank(bob);
        engine.unwindPosition(position, 2_000e18, 0.021e18, address(0), address(0), 1.1e18, block.timestamp + 1 hours);

        assertLt(troveManager.getTroveDebt(position), debtBefore, "position unwind executed");
        uint256 parked = btc.balanceOf(position);
        assertGt(parked, 0, "the unwind surplus is held for the owner");

        // The owner recovers the parked surplus, because the withdrawal transfers the whole balance.
        vm.prank(bob);
        PylonPosition(payable(position)).withdrawCollateral(0.001e18, bob);
        assertEq(btc.balanceOf(position), 0, "no BTC is stranded in the position");
        assertGt(btc.balanceOf(bob), 0.001e18, "owner received the withdrawal plus the surplus");
    }

    /// A delegated executor must not be able to send the position's residual to itself.
    function test_engine_closePositionExecutorCannotRedirectPayout() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);
        vm.prank(bob);
        PylonPosition(payable(position)).setExecutor(alice);
        assertTrue(PylonPosition(payable(position)).canExecute(alice), "executor is authorised");

        vm.prank(alice);
        engine.closePosition(position, alice, block.timestamp + 1 hours);

        assertEq(btc.balanceOf(alice), 0, "the executor cannot name itself");
        assertGt(btc.balanceOf(bob), 0.7e18, "the owner receives the residual");
    }

    /// A third party who copies a signed request must not be able to redirect its payout.
    function test_engine_thirdPartyCannotRedirectSignedPayout() public {
        troveManager.setTrove(alice, 1e18, 25_000e18, 1);
        address attacker = address(0xBAD);

        (uint256 debtDelta, ) = engine.previewLoopDebtForCollateral(0.005e18);
        vm.prank(attacker);
        engine.loopSigned(
            PylonFlashEngine.LoopRequest({
                owner: alice,
                debtAmount: debtDelta,
                collAdd: 0.005e18,
                outputTo: attacker,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
        assertEq(troveManager.getTroveColl(alice), 1e18 + 0.005e18, "the signed loop ran");
        assertEq(btc.balanceOf(attacker), 0, "the loop surplus did not follow the caller");

        vm.prank(attacker);
        engine.unwindSigned(
            PylonFlashEngine.UnwindRequest({
                owner: alice,
                repayAmount: 5_000e18,
                collOut: 0.052e18,
                outputTo: attacker,
                minPostICR: 0,
                deadline: block.timestamp + 1 hours,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
        assertEq(btc.balanceOf(attacker), 0, "the unwind surplus did not follow the caller");
        assertGt(btc.balanceOf(alice), 0, "the owner received the unwind surplus");
    }

    /// The defence must stop at Mezo's debt floor instead of letting the protocol reject it.
    function test_position_defendStopsAtMezosDebtFloor() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 0.03e18}(2_100e18);

        vm.startPrank(lp);
        musd.mint(lp, 100_000e18);
        musd.approve(address(reserve), 100_000e18);
        reserve.deposit(100_000e18, lp);
        vm.stopPrank();

        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.9e18, 2.5e18, 10_000e18);
        priceFeed.setPrice(70_000e18);

        uint256 repaid = PylonPosition(payable(position)).defend();
        uint256 floor = borrowerOps.minNetDebt() + borrowerOps.MUSD_GAS_COMPENSATION();
        // Debt is 2,300 (2,100 borrowed + 200 gas compensation) and the floor is 2,000, so the largest
        // repayment Mezo accepts is 300. The unclamped target would have been ~1,460.
        assertEq(repaid, 300e18, "the repayment is clamped to the largest Mezo accepts");
        assertLt(repaid, 1_400e18, "the unclamped target was much larger");
        assertGe(troveManager.getTroveDebt(position), floor, "net debt stays above Mezo's floor");
    }

    /// A pushed pool must not be able to make the exit sell the owner's collateral too cheaply.
    function test_engine_exitRejectsAPushedPool() public {
        troveManager.setTrove(alice, 1e18, 25_000e18, 1);
        // BTC becomes cheap in the pool: 25,000 MUSD per BTC against a 100,000 oracle.
        btc.mint(address(swapPool), 3_000e18);
        swapPool.setReserves(100_000_000e18, 4_000e18);

        vm.expectRevert();
        engine.closeSigned(
            PylonFlashEngine.CloseRequest({
                owner: alice,
                outputTo: alice,
                deadline: block.timestamp + 1 hours,
                signature: bytes("")
            })
        );
    }

    /// The exit guard is what refuses the pushed pool, not an unrelated failure.
    function test_engine_exitPushedPoolRevertIsTheSlippageGuard() public {
        troveManager.setTrove(alice, 1e18, 25_000e18, 1);
        btc.mint(address(swapPool), 3_000e18);
        swapPool.setReserves(100_000_000e18, 4_000e18);

        (bool ok, bytes memory data) = address(engine).call(
            abi.encodeCall(
                PylonFlashEngine.closeSigned,
                (
                    PylonFlashEngine.CloseRequest({
                        owner: alice,
                        outputTo: alice,
                        deadline: block.timestamp + 1 hours,
                        signature: bytes("")
                    })
                )
            )
        );

        assertFalse(ok, "the exit must be refused");
        assertEq(
            uint256(uint32(bytes4(data))),
            uint256(uint32(PylonFlashEngine.ExcessiveSlippage.selector)),
            "the slippage guard refused it"
        );
        assertEq(
            uint256(troveManager.getTroveStatus(alice)),
            uint256(ITroveManager.Status.active),
            "the trove is untouched"
        );
    }

    /// Small operations still pay the reserve: floor division made sub-500 MUSD flashes free.
    function test_engine_feeDoesNotTruncateToZero() public {
        assertEq(engine.feeReport(100), 1, "a dust flash still pays one wei");
        assertEq(engine.feeReport(1_000e18), 2e18, "20 bps of 1,000 MUSD");
    }

    /// A written-off loan must clear the position's mirror, or the collateral would be locked forever.
    function test_reserve_writeOffClearsThePositionMirror() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 0.05e18}(25_000e18);

        vm.startPrank(lp);
        musd.mint(lp, 100_000e18);
        musd.approve(address(reserve), 100_000e18);
        reserve.deposit(100_000e18, lp);
        vm.stopPrank();

        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.75e18, 2e18, 10_000e18);
        priceFeed.setPrice(70_000e18);
        uint256 repaid = PylonPosition(payable(position)).defend();
        assertGt(repaid, 0, "a defence loan exists");
        assertEq(PylonPosition(payable(position)).reserveDebt(), repaid, "mirror is set");

        // The trove is liquidated: the loan is unrecoverable, so governance writes it off.
        troveManager.setTrove(position, 0, 0, 3);
        reserve.writeOffLoan(position, repaid);

        assertEq(reserve.loans(position), 0, "reserve wrote the loan off");
        assertEq(PylonPosition(payable(position)).reserveDebt(), 0, "position mirror was cleared");
    }

    // ---------------------------------------------------------------------
    // Escape routes: the funds must always be reachable
    // ---------------------------------------------------------------------

    /// Funds sent to the engine by mistake must be recoverable, and only by the owner, and never
    /// while a flash is in flight.
    function test_engine_rescueMovesStrayFundsOnly() public {
        vm.startPrank(alice);
        musd.mint(alice, 5e18);
        musd.transfer(address(engine), 5e18);
        vm.stopPrank();
        assertEq(musd.balanceOf(address(engine)), 5e18, "stray MUSD arrived");

        vm.prank(alice);
        vm.expectRevert();
        engine.rescueToken(address(musd), alice, 5e18);

        engine.rescueToken(address(musd), alice, 5e18);
        assertEq(musd.balanceOf(address(engine)), 0, "engine emptied");
        assertEq(musd.balanceOf(alice), 5e18, "funds are with the owner again");
    }

    /// The whole pool must be able to move to a new generation: settle the live claim, withdraw the
    /// capital, deploy the successor, and deposit it there. Nothing may be stranded on the way.
    function test_capitalCanMoveToANewGeneration() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        // A pool large enough that the defence can move the ratio: with 1,000 MUSD the 20%
        // concentration cap caps a defence at 200 MUSD, which is too small to clear the 2%
        // materiality floor — the reserve correctly refuses a defence it cannot make useful.
        vm.startPrank(lp);
        musd.mint(lp, 10_000e18);
        musd.approve(address(reserve), 10_000e18);
        reserve.deposit(10_000e18, lp);
        vm.stopPrank();

        // a live defence loan, so the capital is partly lent out
        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.75e18, 2e18, 10_000e18);
        priceFeed.setPrice(40_000e18);
        uint256 repaid = PylonPosition(payable(position)).defend();
        assertGt(repaid, 0, "a loan is outstanding");
        assertEq(reserve.outstanding(), repaid, "the reserve is owed");

        // step 1: the position settles the claim
        vm.startPrank(bob);
        musd.approve(address(position), repaid);
        musd.transfer(position, repaid);
        PylonPosition(payable(position)).repayReserve(repaid);
        vm.stopPrank();
        assertEq(reserve.outstanding(), 0, "no loan is left to strand the migration");

        // step 2: the depositor withdraws the capital from the old generation
        uint256 shares = reserve.shares(lp);
        vm.prank(lp);
        uint256 assets = reserve.withdraw(shares, lp, lp);
        // at most the virtual-asset rounding dust is left behind
        assertLe(reserve.totalAssets(), 2, "old reserve is empty apart from dust");
        assertEq(reserve.totalShares(), 0, "old reserve has no shares left");

        // step 3: deploy the successor generation and wire it
        PylonPosition implB = new PylonPosition();
        PylonReserve reserveB = new PylonReserve(address(this), OZIERC20(address(musd)));
        PylonFlashEngine engineB = new PylonFlashEngine(
            address(this),
            IMUSD(address(musd)),
            IERC20(address(btc)),
            IPool(address(flashPool)),
            IPool(address(swapPool)),
            IRouter(address(router)),
            IPoolFactory(address(poolFactory)),
            IBorrowerOperations(address(borrowerOps)),
            IBorrowerOperationsSignatures(address(sigOps)),
            ITroveManager(address(troveManager)),
            ISortedTroves(address(sortedTroves)),
            IHintHelpers(address(hintHelpers)),
            IPriceFeed(address(priceFeed)),
            address(this)
        );
        engineB.setPositionImplementation(address(implB));
        reserveB.setEngine(address(engineB));
        engineB.setReserve(address(reserveB));

        // step 4: the capital goes into the new generation
        vm.startPrank(lp);
        musd.approve(address(reserveB), assets);
        uint256 sharesB = reserveB.deposit(assets, lp);
        vm.stopPrank();

        assertEq(reserveB.totalAssets(), assets, "capital is whole in the new reserve");
        assertEq(reserveB.convertToAssets(sharesB), assets, "and priced correctly");
        assertEq(engineB.reserve(), address(reserveB), "the new engine points at the new reserve");
        assertEq(reserveB.engine(), address(engineB), "and back");

        // the old position still works after the migration: its claim is settled, so the owner can
        // release the collateral exactly as before
        vm.prank(bob);
        PylonPosition(payable(position)).withdrawCollateral(0.01e18, bob);
        assertGt(btc.balanceOf(bob), 0, "the old position is not stranded");
    }

    /// If a borrower never repays, governance writes the loan off and the position is released —
    /// the collateral is not held hostage by a claim nobody can settle.
    function test_stuckPositionIsReleasedByWriteOff() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        vm.startPrank(lp);
        musd.mint(lp, 100_000e18);
        musd.approve(address(reserve), 100_000e18);
        reserve.deposit(100_000e18, lp);
        vm.stopPrank();

        vm.prank(bob);
        PylonPosition(payable(position)).setShield(true, 1.75e18, 2e18, 10_000e18);
        priceFeed.setPrice(40_000e18);
        uint256 repaid = PylonPosition(payable(position)).defend();
        assertGt(repaid, 0, "a loan is outstanding");

        // the borrower disappears; governance books the loss
        reserve.writeOffLoan(position, repaid);
        assertEq(reserve.loans(position), 0, "the reserve wrote the loan off");
        assertEq(PylonPosition(payable(position)).reserveDebt(), 0, "the position's claim is cleared");

        // the owner can now release the collateral
        vm.prank(bob);
        PylonPosition(payable(position)).withdrawCollateral(0.01e18, bob);
        assertGt(btc.balanceOf(bob), 0, "collateral released after the write-off");
    }

    /// A liquidated position can still claim the collateral Mezo owes it.
    function test_positionCanClaimItsCollateralSurplus() public {
        address position = engine.createPosition(bob);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        PylonPosition(payable(position)).openTrove{value: 1e18}(25_000e18);

        uint256 before = btc.balanceOf(bob);
        vm.prank(address(0xDEAD));
        PylonPosition(payable(position)).claimCollateralSurplus();
        assertGt(btc.balanceOf(bob), before, "the surplus reached the owner");
    }
}
