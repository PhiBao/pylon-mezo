// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    IERC20,
    IMUSD,
    ITroveManager,
    IBorrowerOperations,
    IBorrowerOperationsSignatures,
    ISortedTroves,
    IHintHelpers,
    IPriceFeed
} from "./interfaces/IMezo.sol";
import {IPylonEngine} from "./interfaces/IPylonEngine.sol";
import {IPool, IPoolCallee, IPoolFactory, IRouter} from "./interfaces/ITigris.sol";
import {IPylonReserve, IPylonPosition} from "./interfaces/IPylon.sol";
import {PylonMath} from "./libraries/PylonMath.sol";
import {Clones} from "./libraries/Clones.sol";

/// @title PylonFlashEngine
/// @notice Atomic leverage, self-deleveraging and exit engine for Mezo bitcoin troves, funded by
///         optimistic flash liquidity from Mezo's native Tigris pools.
///
/// @dev Why this works, and only on Mezo:
///      1. `BorrowerOperationsSignatures` (a Mezo core contract) lets a router act on a user's
///         *existing, native* trove from a single EIP-712 signature, so Pylon never takes custody
///         and never forces the position into a proprietary vault.
///      2. Tigris pools are Solidly-style and implement `IPoolCallee.hook`, so MUSD can be borrowed
///         and repaid inside one transaction.
///      3. Mezo's BTC is an 18-decimal ERC-20/native precompile, so BTC obtained from a swap can be
///         forwarded as `msg.value` into a trove adjustment in the next call.
///
/// @dev Two pools, on purpose. A Solidly-style pool cannot be swapped inside its own flash callback:
///      its reserves are only recomputed after the callback returns, so a nested swap sees an
///      understated balance and under-reports the input (or underflows). Pylon therefore flashes
///      MUSD from `flashPool` (a MUSD-containing pool) and swaps on `swapPool` (the MUSD/BTC pool).
///      Every flash repays `amount + amount*fee/(10000-fee)` so the pool's k-invariant still holds.
///
/// @dev Every operation is exact. The user signs the precise collateral delta and debt delta via
///      EIP-712; that signature *is* the slippage guard. If the swap cannot deliver the signed
///      collateral, the whole transaction reverts.
contract PylonFlashEngine is IPoolCallee, IPylonEngine, Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Immutable wiring (Mezo core + Tigris)
    // ---------------------------------------------------------------------

    IMUSD public immutable override musd;
    IERC20 public immutable override btc;
    IPool public immutable flashPool;
    IPool public immutable swapPool;
    IRouter public immutable override router;
    IPoolFactory public immutable poolFactory;
    IBorrowerOperations public immutable override borrowerOps;
    IBorrowerOperationsSignatures public immutable borrowerOpsSignatures;
    ITroveManager public immutable override troveManager;
    ISortedTroves public immutable override sortedTroves;
    IHintHelpers public immutable override hintHelpers;
    IPriceFeed public immutable override priceFeed;

    /// @notice True when MUSD is `token0` of the flash pool.
    bool public immutable flashMusdIsToken0;

    /// @notice True when MUSD is `token0` of the MUSD/BTC swap pool (differs per network).
    bool public immutable override musdIsToken0;

    /// @notice True when the flash pool is a stable-curve pool (affects invariant accounting only).
    bool public immutable flashPoolStable;

    /// @notice Mezo's flat liquidation gas compensation, mirrored for exact sizing.
    uint256 public immutable override gasCompensation;

    /// @notice Mezo's minimum net debt, mirrored for exact sizing.
    uint256 public immutable override minNetDebt;

    // ---------------------------------------------------------------------
    // Governance configuration
    // ---------------------------------------------------------------------

    /// @notice Shield pool that receives flash fees and funds defensive repayments.
    address public override reserve;

    /// @notice Fallback fee recipient when no reserve is configured.
    address public treasury;

    /// @notice Pylon origination fee in basis points of the flashed notional (max 1%).
    uint16 public flashFeeBps;

    /// @notice Implementation contract cloned for every Pylon position.
    address public positionImplementation;

    mapping(address => bool) public override isPosition;

    // ---------------------------------------------------------------------
    // Flash context (set for the duration of one flash, cleared inside the hook)
    // ---------------------------------------------------------------------

    uint8 private constant OP_NONE = 0;
    uint8 private constant OP_LOOP = 1;
    uint8 private constant OP_UNWIND = 2;
    uint8 private constant OP_CLOSE = 3;
    uint8 private constant OP_LOOP_POSITION = 4;
    uint8 private constant OP_UNWIND_POSITION = 5;
    uint8 private constant OP_CLOSE_POSITION = 6;

    uint8 private _op;
    uint256 private _btcBefore;
    uint256 private _musdBefore;
    uint256 private _resultPrimary;
    uint256 private _resultSecondary;

    // ---------------------------------------------------------------------
    // Request structs
    // ---------------------------------------------------------------------

    /// @notice Flash a loan against the trove and convert the borrowed MUSD into collateral.
    struct LoopRequest {
        address owner; // native trove owner (EOA)
        uint256 debtAmount; // MUSD borrowed from the trove (signed)
        uint256 collAdd; // BTC collateral added to the trove (signed)
        address outputTo; // receives swap surplus
        uint256 minPostICR; // post-operation ICR floor in wad (0 = skip)
        uint256 deadline;
        address upperHint;
        address lowerHint;
        bytes signature; // EIP-712 AdjustTrove authorisation
    }

    /// @notice Repay trove debt out of the trove's own collateral: no MUSD needed up front.
    struct UnwindRequest {
        address owner;
        uint256 repayAmount; // MUSD repaid to the trove (signed)
        uint256 collOut; // BTC withdrawn from the trove (signed, ceiling)
        address outputTo;
        uint256 minPostICR;
        uint256 deadline;
        address upperHint;
        address lowerHint;
        bytes signature;
    }

    /// @notice Exit a native trove completely, funded by its own collateral.
    struct CloseRequest {
        address owner;
        address outputTo;
        uint256 deadline;
        bytes signature; // EIP-712 CloseTrove authorisation
    }

    struct HookPayload {
        uint8 op;
        address owner;
        address outputTo;
        uint256 amountIn; // MUSD flashed
        uint256 collAdd; // loop: exact BTC to add
        uint256 collOut; // unwind: exact BTC ceiling to withdraw
        uint256 minPostICR;
        uint256 deadline;
        address upperHint;
        address lowerHint;
        bytes signature;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Looped(address indexed owner, uint256 musdBorrowed, uint256 btcAdded, uint256 feeMusd);
    event Unwound(address indexed owner, uint256 musdRepaid, uint256 btcWithdrawn, uint256 btcSwapped, uint256 feeMusd);
    event Exited(address indexed owner, uint256 musdRepaid, uint256 btcReturned, uint256 feeMusd);
    event PositionCreated(address indexed owner, address indexed position);
    event ReserveUpdated(address indexed reserve);
    event FlashFeeUpdated(uint16 feeBps);
    event TreasuryUpdated(address indexed treasury);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotFlashPool();
    error NoActiveFlash();
    error NotSelfInitiated();
    error NotPosition();
    error NotPositionExecutor();
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error UnexpectedFlashAmount(uint256 expected, uint256 actual);
    error InsufficientSwapOutput(uint256 required, uint256 actual);
    error PostICRTooLow(uint256 icr, uint256 floor);
    error TroveNotActive();
    error DebtAccountingMismatch();
    error UnsupportedPool();
    error DeadlinePassed();
    error InsufficientDebt();
    error InvalidConfiguration();
    /// @notice A nested leg of an atomic operation failed. Carries the stage and the inner revert
    ///         data so a caller (or the interface) can see exactly which leg broke.
    error StageFailed(uint8 stage, uint256 gasLeft, bytes reason);
    /// @notice The callback payload does not describe the operation this engine started.
    error PayloadMismatch();
    /// @notice The flash venue returned without servicing the callback, so nothing was executed.
    error FlashNotServiced();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address owner_,
        IMUSD musd_,
        IERC20 btc_,
        IPool flashPool_,
        IPool swapPool_,
        IRouter router_,
        IPoolFactory poolFactory_,
        IBorrowerOperations borrowerOps_,
        IBorrowerOperationsSignatures borrowerOpsSignatures_,
        ITroveManager troveManager_,
        ISortedTroves sortedTroves_,
        IHintHelpers hintHelpers_,
        IPriceFeed priceFeed_,
        address treasury_
    ) Ownable(owner_) {
        if (
            address(musd_) == address(0) || address(btc_) == address(0) || address(flashPool_) == address(0)
                || address(swapPool_) == address(0) || address(router_) == address(0) || address(borrowerOps_) == address(0)
                || address(borrowerOpsSignatures_) == address(0) || address(troveManager_) == address(0)
                || address(sortedTroves_) == address(0) || address(hintHelpers_) == address(0)
        ) revert ZeroAddress();

        musd = musd_;
        btc = btc_;
        flashPool = flashPool_;
        swapPool = swapPool_;
        router = router_;
        poolFactory = poolFactory_;
        borrowerOps = borrowerOps_;
        borrowerOpsSignatures = borrowerOpsSignatures_;
        troveManager = troveManager_;
        sortedTroves = sortedTroves_;
        hintHelpers = hintHelpers_;
        priceFeed = priceFeed_;
        treasury = treasury_;

        // The swap venue must be the MUSD/BTC volatile pool: that is where BTC is priced.
        bool swapOk = (swapPool_.token0() == address(musd_) && swapPool_.token1() == address(btc_))
            || (swapPool_.token0() == address(btc_) && swapPool_.token1() == address(musd_));
        if (!swapOk || swapPool_.stable()) revert UnsupportedPool();

        // The flash venue must contain MUSD and must not be the swap venue.
        bool flashOk = flashPool_.token0() == address(musd_) || flashPool_.token1() == address(musd_);
        if (!flashOk || address(flashPool_) == address(swapPool_)) revert UnsupportedPool();

        flashMusdIsToken0 = flashPool_.token0() == address(musd_);
        flashPoolStable = flashPool_.stable();
        musdIsToken0 = swapPool_.token0() == address(musd_);

        gasCompensation = borrowerOps_.MUSD_GAS_COMPENSATION();
        minNetDebt = borrowerOps_.minNetDebt();
        flashFeeBps = 20; // 0.20% of the flashed notional
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    function setReserve(address reserve_) external onlyOwner {
        reserve = reserve_;
        emit ReserveUpdated(reserve_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setFlashFeeBps(uint16 feeBps) external onlyOwner {
        if (feeBps > 100) revert FeeTooHigh();
        flashFeeBps = feeBps;
        emit FlashFeeUpdated(feeBps);
    }

    function setPositionImplementation(address implementation) external onlyOwner {
        if (implementation == address(0)) revert ZeroAddress();
        positionImplementation = implementation;
    }

    /// @notice Deploys a Pylon position owned by `owner`. Anyone may create one for any address.
    function createPosition(address owner) external returns (address position) {
        if (owner == address(0)) revert ZeroAddress();
        if (positionImplementation == address(0)) revert ZeroAddress();
        position = Clones.clone(positionImplementation);
        IPylonPosition(position).initialize(owner, address(this));
        isPosition[position] = true;
        if (reserve != address(0)) {
            IPylonReserve(reserve).registerPosition(position);
        }
        emit PositionCreated(owner, position);
    }

    // ---------------------------------------------------------------------
    // Native trove operations (zero migration: EIP-712 signatures)
    // ---------------------------------------------------------------------

    /// @notice Borrow against a native trove, swap the borrowed MUSD for BTC, and post it back as
    ///         collateral — one transaction, no up-front MUSD, no custody transfer.
    function loopSigned(LoopRequest calldata r) external nonReentrant returns (uint256 btcOut, uint256 feeMusd) {
        _requireDeadline(r.deadline);
        if (r.debtAmount == 0 || r.collAdd == 0) revert ZeroAmount();
        _requireActiveTrove(r.owner);

        feeMusd = _pylonFee(r.debtAmount);
        _flash(
            HookPayload({
                op: OP_LOOP,
                owner: r.owner,
                outputTo: r.outputTo == address(0) ? r.owner : r.outputTo,
                amountIn: r.debtAmount,
                collAdd: r.collAdd,
                collOut: 0,
                minPostICR: r.minPostICR,
                deadline: r.deadline,
                upperHint: r.upperHint,
                lowerHint: r.lowerHint,
                signature: r.signature
            })
        );
        return (_resultPrimary, feeMusd);
    }

    /// @notice Repay trove debt out of the trove's own collateral. Works with zero MUSD in the
    ///         owner's wallet: the flash pool supplies it and the released BTC repays the pool.
    function unwindSigned(
        UnwindRequest calldata r
    ) external nonReentrant returns (uint256 musdOut, uint256 btcToOwner) {
        _requireDeadline(r.deadline);
        if (r.repayAmount == 0 || r.collOut == 0) revert ZeroAmount();
        _requireActiveTrove(r.owner);

        _flash(
            HookPayload({
                op: OP_UNWIND,
                owner: r.owner,
                outputTo: r.outputTo == address(0) ? r.owner : r.outputTo,
                amountIn: r.repayAmount,
                collAdd: 0,
                collOut: r.collOut,
                minPostICR: r.minPostICR,
                deadline: r.deadline,
                upperHint: r.upperHint,
                lowerHint: r.lowerHint,
                signature: r.signature
            })
        );
        return (_resultPrimary, _resultSecondary);
    }

    /// @notice Close a native trove entirely and return the residual BTC to the owner.
    function closeSigned(CloseRequest calldata r) external nonReentrant returns (uint256 btcToOwner, uint256 feeMusd) {
        _requireDeadline(r.deadline);
        _requireActiveTrove(r.owner);

        // Persist accrued interest first so the exact flash size is known inside this transaction.
        troveManager.updateSystemAndTroveInterest(r.owner);
        uint256 debt = troveManager.getTroveDebt(r.owner);
        if (debt <= gasCompensation) revert InsufficientDebt();
        uint256 flashAmount = debt - gasCompensation;
        feeMusd = _pylonFee(flashAmount);

        _flash(
            HookPayload({
                op: OP_CLOSE,
                owner: r.owner,
                outputTo: r.outputTo == address(0) ? r.owner : r.outputTo,
                amountIn: flashAmount,
                collAdd: 0,
                collOut: 0,
                minPostICR: 0,
                deadline: r.deadline,
                upperHint: address(0),
                lowerHint: address(0),
                signature: r.signature
            })
        );
        return (_resultPrimary, feeMusd);
    }

    // ---------------------------------------------------------------------
    // Position operations (autonomous, keeper-compatible)
    // ---------------------------------------------------------------------

    function loopPosition(
        address position,
        uint256 debtAmount,
        uint256 collAdd,
        address upperHint,
        address lowerHint,
        uint256 minPostICR,
        uint256 deadline
    ) external nonReentrant returns (uint256 btcOut, uint256 feeMusd) {
        _requirePositionExecutor(position);
        _requireDeadline(deadline);
        if (debtAmount == 0 || collAdd == 0) revert ZeroAmount();

        feeMusd = _pylonFee(debtAmount);
        _flash(
            HookPayload({
                op: OP_LOOP_POSITION,
                owner: position,
                outputTo: position,
                amountIn: debtAmount,
                collAdd: collAdd,
                collOut: 0,
                minPostICR: minPostICR,
                deadline: deadline,
                upperHint: upperHint,
                lowerHint: lowerHint,
                signature: bytes("")
            })
        );
        return (_resultPrimary, feeMusd);
    }

    function unwindPosition(
        address position,
        uint256 repayAmount,
        uint256 collOut,
        address upperHint,
        address lowerHint,
        uint256 minPostICR,
        uint256 deadline
    ) external nonReentrant returns (uint256 musdOut, uint256 btcToPosition) {
        _requirePositionExecutor(position);
        _requireDeadline(deadline);
        if (repayAmount == 0 || collOut == 0) revert ZeroAmount();

        _flash(
            HookPayload({
                op: OP_UNWIND_POSITION,
                owner: position,
                outputTo: position,
                amountIn: repayAmount,
                collAdd: 0,
                collOut: collOut,
                minPostICR: minPostICR,
                deadline: deadline,
                upperHint: upperHint,
                lowerHint: lowerHint,
                signature: bytes("")
            })
        );
        return (_resultPrimary, _resultSecondary);
    }

    function closePosition(
        address position,
        address outputTo,
        uint256 deadline
    ) external nonReentrant returns (uint256 btcToOwner, uint256 feeMusd) {
        _requirePositionExecutor(position);
        _requireDeadline(deadline);
        if (IPylonPosition(position).reserveDebt() != 0) revert DebtAccountingMismatch();

        troveManager.updateSystemAndTroveInterest(position);
        uint256 debt = troveManager.getTroveDebt(position);
        if (debt <= gasCompensation) revert InsufficientDebt();
        uint256 flashAmount = debt - gasCompensation;
        feeMusd = _pylonFee(flashAmount);

        _flash(
            HookPayload({
                op: OP_CLOSE_POSITION,
                owner: position,
                outputTo: outputTo == address(0) ? IPylonPosition(position).owner() : outputTo,
                amountIn: flashAmount,
                collAdd: 0,
                collOut: 0,
                minPostICR: 0,
                deadline: deadline,
                upperHint: address(0),
                lowerHint: address(0),
                signature: bytes("")
            })
        );
        return (_resultPrimary, feeMusd);
    }

    // ---------------------------------------------------------------------
    // Flash core
    // ---------------------------------------------------------------------

    function _flash(HookPayload memory payload) private {
        _op = payload.op;
        _btcBefore = btc.balanceOf(address(this));
        _musdBefore = musd.balanceOf(address(this));
        _resultPrimary = 0;
        _resultSecondary = 0;

        uint256 amount = payload.amountIn;
        flashPool.swap(
            flashMusdIsToken0 ? amount : 0,
            flashMusdIsToken0 ? 0 : amount,
            address(this),
            abi.encode(payload)
        );

        // `hook` clears `_op`. If it is still set, the venue returned without servicing the flash:
        // no leg ran and the operation would have reported success having done nothing. Reverting also
        // prevents `_op` from staying stuck for the caller's next attempt.
        if (_op != OP_NONE) revert FlashNotServiced();
    }

    /// @inheritdoc IPoolCallee
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external override {
        if (msg.sender != address(flashPool)) revert NotFlashPool();
        if (_op == OP_NONE) revert NoActiveFlash();
        if (sender != address(this)) revert NotSelfInitiated();

        HookPayload memory p = abi.decode(data, (HookPayload));
        uint256 flashed = flashMusdIsToken0 ? amount0 : amount1;
        if (flashed != p.amountIn) revert UnexpectedFlashAmount(p.amountIn, flashed);

        uint8 op = _op;
        // The payload must describe the operation the engine started. Without this check a payload
        // could be decoded against a different op's expectations.
        if (p.op != op) revert PayloadMismatch();
        _op = OP_NONE;

        if (op == OP_LOOP) {
            _runLoop(p);
        } else if (op == OP_UNWIND) {
            _runUnwind(p);
        } else if (op == OP_CLOSE) {
            _runClose(p);
        } else if (op == OP_LOOP_POSITION) {
            _runLoopPosition(p);
        } else if (op == OP_UNWIND_POSITION) {
            _runUnwindPosition(p);
        } else if (op == OP_CLOSE_POSITION) {
            _runClosePosition(p);
        } else {
            revert NoActiveFlash();
        }
    }

    /// @dev Loop: spend the flashed MUSD (less both fees) on collateral, then borrow exactly the
    ///      signed debt delta, which repays the flash and the origination fee in full.
    function _runLoop(HookPayload memory p) private {
        uint256 fees = _totalFees(p.amountIn);
        uint256 swapIn = p.amountIn - fees;
        uint256 btcOut = _swap(musd, btc, swapIn, p.collAdd, p.deadline);

        _adjustSigned(p, 0, p.amountIn, true, p.collAdd);

        _repayFlash(p.amountIn);
        _payFee(_pylonFee(p.amountIn));

        uint256 surplus = btcOut - p.collAdd;
        if (surplus > 0) btc.transfer(p.outputTo, surplus);
        _sweepMusd(p.outputTo);
        _requirePostICR(p.owner, p.minPostICR);
        _resultPrimary = btcOut;
        _resultSecondary = feeReport(p.amountIn);
        emit Looped(p.owner, p.amountIn, p.collAdd, feeReport(p.amountIn));
    }

    /// @dev Unwind: flash the exact repayment, hand it to the signature helper (which burns it from
    ///      this engine, its caller), withdraw the signed collateral ceiling, and sell just enough
    ///      BTC to repay the flash plus both fees. Works with zero MUSD in the owner's wallet.
    function _runUnwind(HookPayload memory p) private {
        _requireRepaymentCapacity(p.amountIn);
        _adjustSigned(p, p.collOut, p.amountIn, false, 0);

        uint256 need = p.amountIn + _totalFees(p.amountIn);
        uint256 btcIn = _amountInForExactOut(btc, need);
        if (btcIn > p.collOut) revert InsufficientSwapOutput(p.collOut, btcIn);
        uint256 got = _swap(btc, musd, btcIn, need, p.deadline);

        _repayFlash(p.amountIn);
        _payFee(_pylonFee(p.amountIn));

        uint256 musdSurplus = got - need;
        if (musdSurplus > 0) musd.transfer(p.outputTo, musdSurplus);
        uint256 btcSurplus = p.collOut - btcIn;
        if (btcSurplus > 0) btc.transfer(p.outputTo, btcSurplus);
        _sweepMusd(p.outputTo);
        _sweepBtc(p.outputTo);
        _requirePostICR(p.owner, p.minPostICR);
        _resultPrimary = got;
        _resultSecondary = btcSurplus;
        emit Unwound(p.owner, p.amountIn, p.collOut, btcIn, feeReport(p.amountIn));
    }

    /// @dev Close: flash the trove's debt (less gas compensation), close it, and sell a slice of the
    ///      released collateral to repay the flash plus fees. Everything else returns to the owner.
    function _runClose(HookPayload memory p) private {
        _requireRepaymentCapacity(p.amountIn);
        borrowerOpsSignatures.closeTroveWithSignature(p.owner, address(this), p.signature, p.deadline);
        _exitWithCollateral(p);
    }

    function _runLoopPosition(HookPayload memory p) private {
        uint256 fees = _totalFees(p.amountIn);
        uint256 btcOut;
        try this.swapFor(p.amountIn - fees, p.collAdd, p.deadline, true) returns (uint256 out) {
            btcOut = out;
        } catch (bytes memory reason) {
            revert StageFailed(1, gasleft(), reason);
        }

        try IPylonPosition(p.owner).executeTroveAdjust{value: p.collAdd}(0, p.amountIn, true, p.upperHint, p.lowerHint) {
        } catch (bytes memory reason) {
            revert StageFailed(2, gasleft(), reason);
        }

        _repayFlash(p.amountIn);
        _payFee(_pylonFee(p.amountIn));

        uint256 surplus = btcOut - p.collAdd;
        if (surplus > 0) btc.transfer(p.outputTo, surplus);
        _sweepMusd(p.outputTo);
        _requirePostICR(p.owner, p.minPostICR);
        _resultPrimary = btcOut;
        _resultSecondary = feeReport(p.amountIn);
        emit Looped(p.owner, p.amountIn, p.collAdd, feeReport(p.amountIn));
    }

    function _runUnwindPosition(HookPayload memory p) private {
        musd.transfer(p.owner, p.amountIn);
        try IPylonPosition(p.owner).executeTroveAdjust(p.collOut, p.amountIn, false, p.upperHint, p.lowerHint) {
        } catch (bytes memory reason) {
            revert StageFailed(2, gasleft(), reason);
        }

        uint256 need = p.amountIn + _totalFees(p.amountIn);
        uint256 btcIn = _amountInForExactOut(btc, need);
        if (btcIn > p.collOut) revert InsufficientSwapOutput(p.collOut, btcIn);
        uint256 got;
        try this.swapFor(btcIn, need, p.deadline, false) returns (uint256 out) {
            got = out;
        } catch (bytes memory reason) {
            revert StageFailed(3, gasleft(), reason);
        }

        _repayFlash(p.amountIn);
        _payFee(_pylonFee(p.amountIn));

        uint256 musdSurplus = got - need;
        if (musdSurplus > 0) musd.transfer(p.outputTo, musdSurplus);
        uint256 btcSurplus = p.collOut - btcIn;
        if (btcSurplus > 0) btc.transfer(p.outputTo, btcSurplus);
        _sweepMusd(p.outputTo);
        _sweepBtc(p.outputTo);
        _requirePostICR(p.owner, p.minPostICR);
        _resultPrimary = got;
        _resultSecondary = btcSurplus;
        emit Unwound(p.owner, p.amountIn, p.collOut, btcIn, feeReport(p.amountIn));
    }

    function _runClosePosition(HookPayload memory p) private {
        musd.transfer(p.owner, p.amountIn);
        IPylonPosition(p.owner).executeClose();
        _exitWithCollateral(p);
    }

    /// @dev Shared exit path: the trove is gone, its collateral is held by the engine, and the flash
    ///      plus fees are repaid out of it. Everything left over goes to the owner.
    function _exitWithCollateral(HookPayload memory p) private {
        uint256 coll = btc.balanceOf(address(this)) - _btcBefore;
        uint256 need = p.amountIn + _totalFees(p.amountIn);
        uint256 btcIn = _amountInForExactOut(btc, need);
        if (btcIn > coll) revert InsufficientSwapOutput(coll, btcIn);
        uint256 got = _swap(btc, musd, btcIn, need, p.deadline);

        _repayFlash(p.amountIn);
        _payFee(_pylonFee(p.amountIn));

        uint256 musdSurplus = got - need;
        if (musdSurplus > 0) musd.transfer(p.outputTo, musdSurplus);
        uint256 btcRemaining = coll - btcIn;
        if (btcRemaining > 0) btc.transfer(p.outputTo, btcRemaining);
        _sweepMusd(p.outputTo);
        _sweepBtc(p.outputTo);
        _resultPrimary = btcRemaining;
        _resultSecondary = feeReport(p.amountIn);
        emit Exited(p.owner, p.amountIn, btcRemaining, feeReport(p.amountIn));
    }

    // ---------------------------------------------------------------------
    // Fee model
    // ---------------------------------------------------------------------

    /// @notice Pylon's origination fee for a flashed notional.
    function feeReport(uint256 amount) public view returns (uint256) {
        return _pylonFee(amount);
    }

    function _pylonFee(uint256 amount) private view returns (uint256) {
        return (amount * flashFeeBps) / 10_000;
    }

    /// @notice Live fee charged by the flash venue, read from the pool factory.
    function flashPoolFeeBps() public view returns (uint256) {
        return poolFactory.getFee(address(flashPool), flashPoolStable);
    }

    /// @notice MUSD that must be returned on top of the principal so the flash pool's invariant holds.
    function _flashFee(uint256 amount) private view returns (uint256) {
        uint256 f = flashPoolFeeBps();
        if (f == 0) return 0;
        // fee must satisfy: fee >= (amount + fee) * f / 10000  =>  fee >= amount * f / (10000 - f)
        uint256 numerator = amount * f;
        uint256 denominator = 10_000 - f;
        return numerator / denominator + 1;
    }

    function _totalFees(uint256 amount) private view returns (uint256) {
        return _pylonFee(amount) + _flashFee(amount);
    }

    function _repayFlash(uint256 amount) private {
        musd.transfer(address(flashPool), amount + _flashFee(amount));
    }

    function _payFee(uint256 amount) private {
        if (amount == 0) return;
        address recipient = reserve == address(0) ? treasury : reserve;
        musd.transfer(recipient, amount);
        if (reserve != address(0)) {
            IPylonReserve(reserve).notifyFee(amount);
        }
    }

    /// @dev Returns per-wei dust created by rounding to the beneficiary instead of leaving it stuck.
    function _sweepMusd(address to) private {
        uint256 balance = musd.balanceOf(address(this));
        if (balance > _musdBefore) {
            musd.transfer(to, balance - _musdBefore);
        }
    }

    function _sweepBtc(address to) private {
        uint256 balance = btc.balanceOf(address(this));
        if (balance > _btcBefore) {
            btc.transfer(to, balance - _btcBefore);
        }
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /// @notice External self-wrapper used only so a failing swap leg can be caught and reported with
    ///         its stage. Callable by anyone but only ever spends this contract's own balances for
    ///         the exact window of the swap.
    function swapFor(uint256 amountIn, uint256 minOut, uint256 deadline, bool musdIn) external returns (uint256) {
        if (msg.sender != address(this)) revert NotSelfInitiated();
        return _swap(musdIn ? musd : btc, musdIn ? btc : musd, amountIn, minOut, deadline);
    }

    /// @dev Swaps `amountIn` for the output asset, enforcing `minOut` at the router level.
    function _swap(
        IERC20 tokenIn,
        IERC20 tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) private returns (uint256 amountOut) {
        _safeApprove(tokenIn, address(router), amountIn);
        IRouter.Route[] memory routes = new IRouter.Route[](1);
        routes[0] = IRouter.Route({
            from: address(tokenIn),
            to: address(tokenOut),
            stable: false,
            factory: router.defaultFactory()
        });
        uint256[] memory amounts = router.swapExactTokensForTokens(amountIn, minOut, routes, address(this), deadline);
        amountOut = amounts[amounts.length - 1];
        if (amountOut < minOut) revert InsufficientSwapOutput(minOut, amountOut);
    }

    /// @dev Input required to obtain exactly `amountOut` from the swap pool, rounded up.
    function _amountInForExactOut(IERC20 tokenIn, uint256 amountOut) private view returns (uint256) {
        return PylonMath.getAmountIn(amountOut, _reserveIn(tokenIn), _reserveOut(tokenIn), swapPoolFeeBps());
    }

    function _reserveIn(IERC20 tokenIn) private view returns (uint256) {
        (uint256 r0, uint256 r1,) = swapPool.getReserves();
        return swapPool.token0() == address(tokenIn) ? r0 : r1;
    }

    function _reserveOut(IERC20 tokenIn) private view returns (uint256) {
        (uint256 r0, uint256 r1,) = swapPool.getReserves();
        return swapPool.token0() == address(tokenIn) ? r1 : r0;
    }

    /// @notice Live fee of the MUSD/BTC swap pool, read from the pool factory.
    function swapPoolFeeBps() public view returns (uint256) {
        return poolFactory.getFee(address(swapPool), swapPool.stable());
    }

    /// @dev Calls the Mezo signature helper for a trove adjustment signed by the trove owner.
    function _adjustSigned(
        HookPayload memory p,
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        uint256 btcToAdd
    ) private {
        borrowerOpsSignatures.adjustTroveWithSignature{value: btcToAdd}(
            collWithdrawal,
            debtChange,
            isDebtIncrease,
            p.upperHint,
            p.lowerHint,
            p.owner,
            address(this),
            p.signature,
            p.deadline
        );
    }

    /// @dev Mezo's signature helper forwards *its own caller* (this engine) as the repayment caller,
    ///      so the burn happens from the engine's balance. Verified on Mezo Testnet: funding the
    ///      helper instead makes Mezo revert with "Caller doesnt have enough mUSD to make repayment".
    ///      This guard makes the requirement explicit and fails loudly rather than mid-flash.
    function _requireRepaymentCapacity(uint256 amount) private view {
        if (musd.balanceOf(address(this)) - _musdBefore < amount) revert DebtAccountingMismatch();
    }

    function _requirePostICR(address trove, uint256 floor) private view {
        if (floor == 0) return;
        uint256 price = priceFeed.fetchPrice();
        uint256 icr = troveManager.getCurrentICR(trove, price);
        if (icr < floor) revert PostICRTooLow(icr, floor);
    }

    function _requireActiveTrove(address owner) private view {
        if (troveManager.getTroveStatus(owner) != ITroveManager.Status.active) revert TroveNotActive();
    }

    function _requirePositionExecutor(address position) private view {
        if (position == address(0) || !isPosition[position]) revert NotPosition();
        if (!IPylonPosition(position).canExecute(msg.sender)) revert NotPositionExecutor();
    }

    function _requireDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlinePassed();
    }

    function _safeApprove(IERC20 token, address spender, uint256 amount) private {
        if (token.allowance(address(this), spender) < amount) {
            token.approve(spender, type(uint256).max);
        }
    }

    // ---------------------------------------------------------------------
    // Views used by the interface, the solver and the simulation endpoint
    // ---------------------------------------------------------------------

    /// @notice MUSD to flash for a loop that adds exactly `collAdd` BTC of collateral.
    /// @dev Solves `flash - pylonFee(flash) - flashFee(flash) >= musdIn(collAdd)`. A closed-form
    ///      estimate is followed by bounded fix-up passes, so the returned value is guaranteed to
    ///      satisfy the invariant exactly (the excess is dust the user keeps). Mirrored in Rust.
    function previewLoopDebtForCollateral(uint256 collAdd) external view returns (uint256 debtDelta, uint256 pylonFee) {
        uint256 swapIn = previewMusdIn(collAdd);
        uint256 flashBps = flashPoolFeeBps();
        // 1 - pylonBps/10000 - flashBps/(10000-flashBps), in tenths of a basis point
        uint256 denominator = 10_000 - flashFeeBps - (10_000 * flashBps + (10_000 - flashBps) - 1) / (10_000 - flashBps);
        debtDelta = (swapIn * 10_000 + denominator - 1) / denominator + 1;
        for (uint256 i = 0; i < 3; i++) {
            uint256 spendable = debtDelta > _totalFees(debtDelta) ? debtDelta - _totalFees(debtDelta) : 0;
            if (spendable >= swapIn) break;
            debtDelta = debtDelta + (swapIn - spendable) + 1;
        }
        pylonFee = _pylonFee(debtDelta);
    }

    /// @notice BTC collateral that lands in the trove for a given signed debt delta.
    function previewLoopCollateralForDebt(uint256 debtDelta) external view returns (uint256 collAdd, uint256 pylonFee) {
        uint256 fees = _totalFees(debtDelta);
        pylonFee = _pylonFee(debtDelta);
        if (debtDelta <= fees) return (0, pylonFee);
        collAdd = previewBtcOut(debtDelta - fees);
    }

    /// @notice MUSD the unwind must produce to repay the flash and both fees.
    function previewUnwindMusdNeeded(uint256 repayAmount) external view returns (uint256) {
        return repayAmount + _totalFees(repayAmount);
    }

    /// @notice BTC that must be swapped to unwind `repayAmount` MUSD of debt.
    function previewUnwindBtcIn(uint256 repayAmount) external view returns (uint256) {
        return _amountInForExactOut(btc, repayAmount + _totalFees(repayAmount));
    }

    /// @notice BTC that must be swapped to exit a trove completely, and the debt being closed.
    function previewClose(address owner) external view returns (uint256 btcIn, uint256 debt) {
        uint256 principal;
        uint256 interest;
        (, principal, interest,,,) = troveManager.getEntireDebtAndColl(owner);
        debt = principal + interest;
        if (debt <= gasCompensation) return (type(uint256).max, debt);
        uint256 flashAmount = debt - gasCompensation;
        btcIn = _amountInForExactOut(btc, flashAmount + _totalFees(flashAmount));
    }

    /// @notice BTC out of the swap pool for a given MUSD input (mirrors the pool curve).
    function previewBtcOut(uint256 musdIn) public view returns (uint256) {
        (uint256 r0, uint256 r1,) = swapPool.getReserves();
        return PylonMath.getAmountOut(musdIn, musdIsToken0 ? r0 : r1, musdIsToken0 ? r1 : r0, swapPoolFeeBps());
    }

    /// @notice MUSD in required for a given BTC output (mirrors the pool curve).
    function previewMusdIn(uint256 btcOut) public view returns (uint256) {
        (uint256 r0, uint256 r1,) = swapPool.getReserves();
        return PylonMath.getAmountIn(btcOut, musdIsToken0 ? r0 : r1, musdIsToken0 ? r1 : r0, swapPoolFeeBps());
    }

    /// @notice Flash venue state, used by the interface header.
    function flashPoolState() external view returns (uint256 musdReserve, uint256 otherReserve, uint256 feeBps) {
        (uint256 r0, uint256 r1,) = flashPool.getReserves();
        musdReserve = flashMusdIsToken0 ? r0 : r1;
        otherReserve = flashMusdIsToken0 ? r1 : r0;
        feeBps = flashPoolFeeBps();
    }

    /// @notice Swap venue state: the pool Pylon trades against for BTC.
    function swapPoolState() external view returns (uint256 musdReserve, uint256 btcReserve, uint256 feeBps) {
        (uint256 r0, uint256 r1,) = swapPool.getReserves();
        musdReserve = musdIsToken0 ? r0 : r1;
        btcReserve = musdIsToken0 ? r1 : r0;
        feeBps = swapPoolFeeBps();
    }
}
