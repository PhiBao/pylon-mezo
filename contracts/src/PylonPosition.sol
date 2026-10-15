// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    IERC20,
    IMUSD,
    ITroveManager,
    IBorrowerOperations,
    ISortedTroves,
    IHintHelpers,
    IPriceFeed
} from "./interfaces/IMezo.sol";
import {IPylonEngine} from "./interfaces/IPylonEngine.sol";
import {IPylonReserve, IPylonPosition} from "./interfaces/IPylon.sol";
import {PylonMath} from "./libraries/PylonMath.sol";

/// @title PylonPosition
/// @notice A user-owned, EIP-1167-cloned automation container for one Mezo bitcoin trove.
///
/// @dev Two reasons positions exist alongside signature mode:
///      1. Autonomous defence. A native EOA trove can only be changed with a fresh EIP-712
///         signature, so its owner (or a keeper acting for them) has to be online at the exact
///         moment risk spikes. A position owns its own trove, so a permissionless keeper can defend
///         it around the clock.
///      2. Shield capital that is actually recoverable. The reserve only ever lends MUSD to repay a
///         position's own debt, and the position only releases collateral once that debt is settled.
///         Every exit path runs through this contract, so the claim is enforced by code, not promise.
contract PylonPosition is IPylonPosition, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Configuration (fixed at initialisation)
    // ---------------------------------------------------------------------

    address public override owner;
    address public override engine;

    /// @notice Shield reserve captured at initialisation.
    /// @dev Reading it from the engine on every call would let a later engine handover re-point
    ///      `repayReserve` at a reserve that has no record of this position's loan, which would make
    ///      the claim unpayable and lock the collateral. The binding is fixed here instead.
    address public reserve;

    IMUSD public musd;
    IERC20 public btc;
    IBorrowerOperations public borrowerOps;
    ITroveManager public troveManager;
    ISortedTroves public sortedTroves;
    IHintHelpers public hintHelpers;
    IPriceFeed public priceFeed;

    /// @notice Optional delegate allowed to run Pylon flash operations for this position.
    address public executor;

    /// @notice MUSD borrowed from the reserve to defend this position, if any.
    uint256 public override reserveDebt;

    // ---------------------------------------------------------------------
    // Shield policy
    // ---------------------------------------------------------------------

    struct ShieldPolicy {
        bool enabled;
        uint64 triggerICR; // defend while the ICR is below this (wad)
        uint64 targetICR; // repay until the ICR reaches at least this (wad)
        uint128 maxPerCall; // absolute MUSD ceiling per defence call
    }

    ShieldPolicy public policy;

    /// @notice Highest ICR a shield may target or trigger on. The band exists to keep a position away
    ///         from the redemption tail, not to grant an unbounded credit line.
    uint64 public constant MAX_SHIELD_ICR = 5e18;

    event Initialized(address indexed owner, address indexed engine);
    event Opened(uint256 btcCollateral, uint256 musdDebt);
    event ShieldConfigured(bool enabled, uint64 triggerICR, uint64 targetICR, uint128 maxPerCall);
    event Defended(uint256 musdRepaid, uint256 preICR, uint256 postICR, uint256 reserveDebt);
    event ReserveRepaid(uint256 amount, uint256 remaining);
    event CollateralWithdrawn(uint256 amount, address to);
    event ExecutorUpdated(address executor);

    error OnlyOwner();
    error OnlyEngine();
    error AlreadyInitialized();
    error ZeroAddress();
    error ShieldDisabled();
    error Healthy();
    error NothingToRepay();
    error ReserveDebtOutstanding();
    error NoImprovement();
    error TroveNotActive();
    error BadShieldConfig();
    error TransferFailed();
    error FullRepaymentNotSupported();
    error NotReserve();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    receive() external payable {}

    /// @dev Transfers are checked: a token that returns `false` instead of reverting would otherwise
    ///      leave value behind while the operation reports success.
    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev Borrowed MUSD cannot be cashed out while the reserve holds a claim on this position:
    ///      without this, an owner could borrow the capacity a defence created, keep the MUSD, and
    ///      leave the reserve's loan backed by a trove it cannot reach.
    function _routeGainToClaimOrOwner(uint256 gained) private {
        if (gained == 0) return;
        if (reserveDebt == 0) {
            _safeTransfer(musd, owner, gained);
            return;
        }
        uint256 toClaim = gained > reserveDebt ? reserveDebt : gained;
        address r = engine_reserve();
        _safeTransfer(musd, r, toClaim);
        IPylonReserve(r).recordRepayment(toClaim);
        reserveDebt -= toClaim;
        emit ReserveRepaid(toClaim, reserveDebt);
        if (gained > toClaim) _safeTransfer(musd, owner, gained - toClaim);
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    function initialize(address owner_, address engine_) external override {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || engine_ == address(0)) revert ZeroAddress();
        // Only the engine may initialise a position, so a stray clone can never be claimed by a third
        // party between creation and wiring.
        if (msg.sender != engine_) revert OnlyEngine();

        owner = owner_;
        engine = engine_;

        IPylonEngine e = IPylonEngine(engine_);
        reserve = e.reserve();
        if (reserve == address(0)) revert ZeroAddress();
        musd = IMUSD(e.musd());
        btc = IERC20(e.btc());
        borrowerOps = IBorrowerOperations(e.borrowerOps());
        troveManager = ITroveManager(e.troveManager());
        sortedTroves = ISortedTroves(e.sortedTroves());
        hintHelpers = IHintHelpers(e.hintHelpers());
        priceFeed = IPriceFeed(e.priceFeed());

        emit Initialized(owner_, engine_);
    }

    /// @notice Who may drive Pylon flash operations for this position.
    function canExecute(address account) external view override returns (bool) {
        // `executor` defaults to the zero address, and no call has a zero sender, but the guard is
        // written explicitly so an unset executor never reads as an authorised delegate.
        if (account == address(0)) return false;
        return account == owner || account == executor;
    }

    function setExecutor(address executor_) external onlyOwner {
        executor = executor_;
        emit ExecutorUpdated(executor_);
    }

    // ---------------------------------------------------------------------
    // Owner entry points
    // ---------------------------------------------------------------------

    /// @notice Opens the position's trove with `msg.value` BTC and `debtAmount` MUSD of debt.
    /// @dev Hints are resolved on-chain so a caller cannot brick the position with bad hints. The
    ///      borrowed MUSD is forwarded to the owner; the collateral stays in the trove.
    function openTrove(uint256 debtAmount) external payable onlyOwner nonReentrant {
        if (debtAmount == 0) revert NothingToRepay();
        (address upper, address lower) = _freshHints(msg.value, _debtAfterOpen(debtAmount));
        borrowerOps.openTrove{value: msg.value}(debtAmount, upper, lower);
        uint256 received = musd.balanceOf(address(this));
        if (received > 0) _routeGainToClaimOrOwner(received);
        emit Opened(msg.value, debtAmount);
    }

    /// @notice Adds `msg.value` BTC collateral, optionally borrowing `debtAdjustment` more MUSD.
    function addCollateral(uint256 debtAdjustment) external payable onlyOwner nonReentrant {
        (uint256 coll, uint256 debt) = _state();
        uint256 newDebt = debt + debtAdjustment + _borrowingFee(debtAdjustment);
        (address upper, address lower) = _freshHints(coll + msg.value, newDebt);
        if (debtAdjustment == 0) {
            borrowerOps.addColl{value: msg.value}(upper, lower);
        } else {
            uint256 before = musd.balanceOf(address(this));
            borrowerOps.adjustTrove{value: msg.value}(0, debtAdjustment, true, upper, lower);
            uint256 gained = musd.balanceOf(address(this)) - before;
            _routeGainToClaimOrOwner(gained);
        }
    }

    /// @notice Repays part of the debt from MUSD the position already holds.
    /// @dev A repayment that clears the debt must go through the exit path: `SortedTroves` needs a
    ///      non-zero nominal ratio, so a zero-debt hint lookup would revert with an arithmetic panic
    ///      instead of a usable error.
    function repay(uint256 amount) external onlyOwner nonReentrant {
        (, uint256 debt) = _state();
        if (amount >= debt) revert FullRepaymentNotSupported();
        (address upper, address lower) = _hintsForRepay(amount);
        borrowerOps.repayMUSD(amount, upper, lower);
    }

    /// @notice Claims collateral that Mezo owes this trove, for example the surplus left after a full
    ///         redemption. Anyone may call it; the proceeds follow the reserve claim first.
    function claimCollateralSurplus() external nonReentrant {
        uint256 before = btc.balanceOf(address(this));
        borrowerOps.claimCollateral();
        uint256 gained = btc.balanceOf(address(this)) - before;
        if (gained == 0) return;
        _safeTransfer(btc, owner, gained);
    }

    /// @notice Clears this position's mirror of a defence loan the reserve has written off.
    /// @dev Without it a written-off loan could never be settled: `repayReserve` needs the reserve to
    ///      record a repayment, and the reserve has nothing left to record, so `reserveDebt` would stay
    ///      above zero and the collateral would be locked forever.
    function writeOffReserveDebt(uint256 amount) external {
        if (msg.sender != engine_reserve()) revert NotReserve();
        reserveDebt = amount >= reserveDebt ? 0 : reserveDebt - amount;
        emit ReserveRepaid(amount, reserveDebt);
    }

    /// @notice Transfers a token that is not part of the position's accounting.
    /// @dev Collateral and MUSD are guarded by the reserve claim; other tokens are free to move.
    function sweep(address token, address to) external onlyOwner {
        if (token == address(btc) || token == address(musd)) revert ReserveDebtOutstanding();
        _safeTransfer(IERC20(token), to, IERC20(token).balanceOf(address(this)));
    }

    /// @notice Withdraws collateral. Blocked while a reserve defence loan is outstanding, so the
    ///         shield's claim is always settled before collateral leaves the position.
    function withdrawCollateral(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (reserveDebt != 0) revert ReserveDebtOutstanding();
        (address upper, address lower) = _hintsForWithdraw(amount);
        borrowerOps.withdrawColl(amount, upper, lower);
        // The whole balance leaves, not only this call's delta: the engine routes loop and unwind
        // surpluses into the position, and a delta-only exit would strand them here forever.
        uint256 balance = btc.balanceOf(address(this));
        _safeTransfer(btc, to, balance);
        emit CollateralWithdrawn(balance, to);
    }

    /// @notice Settles a reserve defence loan: transfers MUSD to the reserve and books it.
    function repayReserve(uint256 amount) external nonReentrant {
        if (msg.sender != owner && msg.sender != engine) revert OnlyOwner();
        uint256 debt = reserveDebt;
        uint256 pay = amount > debt ? debt : amount;
        if (pay == 0) revert NothingToRepay();
        address r = engine_reserve();
        musd.transfer(r, pay);
        IPylonReserve(r).recordRepayment(pay);
        reserveDebt = debt - pay;
        emit ReserveRepaid(pay, reserveDebt);
    }

    // ---------------------------------------------------------------------
    // Shield
    // ---------------------------------------------------------------------

    function setShield(bool enabled, uint64 triggerICR, uint64 targetICR, uint128 maxPerCall) external onlyOwner {
        // Upper bounds matter as much as the lower ones: an unbounded target would let a position ask
        // the reserve to repay its entire debt in one call, and an unbounded trigger would arm a band
        // above every reachable ratio so the reserve can be treated as an open credit line.
        if (enabled && (targetICR <= triggerICR || triggerICR < 1.1e18)) revert BadShieldConfig();
        if (enabled && (targetICR > MAX_SHIELD_ICR || triggerICR > MAX_SHIELD_ICR)) revert BadShieldConfig();
        if (enabled && maxPerCall == 0) revert BadShieldConfig();
        policy = ShieldPolicy({
            enabled: enabled,
            triggerICR: triggerICR,
            targetICR: targetICR,
            maxPerCall: maxPerCall
        });
        emit ShieldConfigured(enabled, triggerICR, targetICR, maxPerCall);
    }

    /// @notice Defence is permissionless: anyone may push the position back to its target ICR using
    ///         reserve capital. That capital can only ever reduce this position's own debt, and the
    ///         reserve's claim is enforced by `withdrawCollateral` / `executeClose`.
    function defend() external nonReentrant returns (uint256 repaid) {
        ShieldPolicy memory p = policy;
        if (!p.enabled) revert ShieldDisabled();

        uint256 price = priceFeed.fetchPrice();
        // Mezo redistributes a liquidated trove's collateral and debt across the remaining troves.
        // The plain getters exclude those pending amounts, so the shield would size against a ratio
        // that looks better than the real one and would stop short of its own target.
        (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingColl,
            uint256 pendingDebt,
            uint256 pendingInterest
        ) = troveManager.getEntireDebtAndColl(address(this));
        coll += pendingColl;
        uint256 debt = principal + interest + pendingDebt + pendingInterest;
        uint256 icr = PylonMath.collateralRatio(coll, debt, price);
        if (icr >= p.triggerICR) revert Healthy();

        uint256 maxDebtAtTarget = PylonMath.debtAtRatio(coll, price, p.targetICR);
        uint256 want = debt > maxDebtAtTarget ? debt - maxDebtAtTarget : 0;
        if (want > p.maxPerCall) want = p.maxPerCall;

        // Mezo rejects a repayment that takes the net debt below its floor, so the largest useful
        // defence is capped there. The caller then sees an honest "cannot defend further" instead of a
        // protocol-level revert that would leave the position undefended.
        uint256 floorDebt = borrowerOps.minNetDebt() + borrowerOps.MUSD_GAS_COMPENSATION();
        uint256 repayable = debt > floorDebt ? debt - floorDebt : 0;
        if (want > repayable) want = repayable;
        if (want == 0) revert NothingToRepay();

        IPylonReserve r = IPylonReserve(engine_reserve());
        uint256 available = r.availableToLend(address(this));
        repaid = want < available ? want : available;
        if (repaid == 0) revert NothingToRepay();

        // The reserve withholds a defence fee, so the amount that can be repaid is what actually
        // arrives; the loan itself is booked in full.
        uint256 before = musd.balanceOf(address(this));
        r.lendTo(repaid);
        uint256 received = musd.balanceOf(address(this)) - before;
        if (received == 0) revert NothingToRepay();
        reserveDebt += repaid;

        (address upper, address lower) = _hintsForRepay(received);
        borrowerOps.repayMUSD(received, upper, lower);

        uint256 postICR = PylonMath.collateralRatio(coll, debt - received, price);
        // A defence that moves the ratio by a rounding amount burns a keeper slot and the position's
        // borrowing room without changing its risk. Require a material improvement.
        if (postICR * 10_000 < icr * 10_200) revert NoImprovement();
        emit Defended(received, icr, postICR, reserveDebt);
    }

    // ---------------------------------------------------------------------
    // Engine entry points (flash-driven)
    // ---------------------------------------------------------------------

    /// @notice Runs a trove adjustment for the flash engine and forwards the resulting MUSD or BTC
    ///         straight back to it, so the flash settles inside the same transaction.
    /// @param upperHint Solver-supplied insertion hint. On-chain hint resolution costs several
    ///        million gas (each trial reads another trove), so the engine passes hints it already
    ///        computed off-chain; the contract validates them and only then falls back to
    ///        `HintHelpers`, with a reduced trial count.
    function executeTroveAdjust(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint
    ) external payable override onlyEngine nonReentrant {
        if (troveManager.getTroveStatus(address(this)) != ITroveManager.Status.active) revert TroveNotActive();
        // The reserve's claim is secured by this trove's collateral. Letting collateral leave while a
        // defence loan is outstanding would hollow out the claim, so every outflow path is guarded —
        // not only the owner-facing withdrawal.
        if (collWithdrawal > 0 && reserveDebt != 0) revert ReserveDebtOutstanding();

        uint256 coll = troveManager.getTroveColl(address(this));
        uint256 debt = troveManager.getTroveDebt(address(this));
        uint256 newColl = isDebtIncrease ? coll + msg.value : coll - collWithdrawal;
        uint256 newDebt = isDebtIncrease ? debt + debtChange + _borrowingFee(debtChange) : debt - debtChange;
        (address upper, address lower) = _hints(newColl, newDebt, upperHint, lowerHint);

        uint256 musdBefore = musd.balanceOf(address(this));
        // Mezo keeps one ledger for native and ERC-20 BTC, so `msg.value` is already credited to this
        // contract when the body runs. Reading the balance without subtracting it would make the
        // post-call delta underflow (Panic 0x11) on every collateral-adding call, which is what broke
        // the position flash loop on chain.
        uint256 btcBefore = btc.balanceOf(address(this)) - msg.value;

        borrowerOps.adjustTrove{value: msg.value}(collWithdrawal, debtChange, isDebtIncrease, upper, lower);

        // A debt increase leaves a gain to forward; a repayment *burns* MUSD the engine pre-funded, so
        // the balance falls. Subtracting blindly would underflow (Panic 0x11) and revert every unwind.
        uint256 musdAfter = musd.balanceOf(address(this));
        uint256 musdGain = musdAfter > musdBefore ? musdAfter - musdBefore : 0;
        if (musdGain > 0) musd.transfer(engine, musdGain);
        uint256 btcGain = btc.balanceOf(address(this)) - btcBefore;
        if (btcGain > 0) btc.transfer(engine, btcGain);
    }

    /// @notice Closes the trove and forwards the collateral to the engine. The reserve must be
    ///         settled first: the shield's claim is never sacrificed to an exit.
    function executeClose() external override onlyEngine nonReentrant {
        if (reserveDebt != 0) revert ReserveDebtOutstanding();
        uint256 before = btc.balanceOf(address(this));
        borrowerOps.closeTrove();
        uint256 gained = btc.balanceOf(address(this)) - before;
        if (gained > 0) btc.transfer(engine, gained);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function health() external view returns (uint256 coll, uint256 debt, uint256 icr, uint256 price) {
        price = priceFeed.fetchPrice();
        coll = troveManager.getTroveColl(address(this));
        debt = troveManager.getTroveDebt(address(this));
        icr = PylonMath.collateralRatio(coll, debt, price);
    }

    /// @dev The reserve is fixed at initialisation; see the `reserve` field for why.
    function engine_reserve() internal view returns (address) {
        return reserve;
    }

    function isActive() external view returns (bool) {
        return troveManager.getTroveStatus(address(this)) == ITroveManager.Status.active;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _state() private view returns (uint256 coll, uint256 debt) {
        coll = troveManager.getTroveColl(address(this));
        debt = troveManager.getTroveDebt(address(this));
    }

    function _debtAfterOpen(uint256 debtAmount) private view returns (uint256) {
        return debtAmount + _borrowingFee(debtAmount) + gasCompensation();
    }

    function gasCompensation() private view returns (uint256) {
        return IPylonEngine(engine).gasCompensation();
    }

    function _borrowingFee(uint256 debt) private view returns (uint256) {
        return debt == 0 ? 0 : borrowerOps.getBorrowingFee(debt);
    }

    /// @dev Prefers validated solver hints; falls back to on-chain resolution with a small trial
    ///      count. `SortedTroves` walks the list if a hint is stale, so a wrong hint costs gas, never
    ///      correctness.
    function _hints(
        uint256 coll,
        uint256 debt,
        address upperHint,
        address lowerHint
    ) private view returns (address upper, address lower) {
        uint256 nicr = PylonMath.nominalCR(coll, debt);
        address self = address(this);
        if (upperHint != address(0) || lowerHint != address(0)) {
            if (sortedTroves.validInsertPosition(nicr, upperHint, lowerHint)) {
                upper = upperHint == self ? address(0) : upperHint;
                lower = lowerHint == self ? address(0) : lowerHint;
                return (upper, lower);
            }
        }
        (address approx,,) = hintHelpers.getApproxHint(
            nicr,
            12,
            uint256(keccak256(abi.encodePacked(block.number, debt)))
        );
        (upper, lower) = sortedTroves.findInsertPosition(nicr, approx, approx);
        if (upper == self) upper = address(0);
        if (lower == self) lower = address(0);
    }

    function _freshHints(uint256 coll, uint256 debt) private view returns (address upper, address lower) {
        return _hints(coll, debt, address(0), address(0));
    }

    function _hintsForRepay(uint256 amount) private view returns (address upper, address lower) {
        (uint256 coll, uint256 debt) = _state();
        uint256 newDebt = debt > amount ? debt - amount : 0;
        return _freshHints(coll, newDebt);
    }

    function _hintsForWithdraw(uint256 amount) private view returns (address upper, address lower) {
        (uint256 coll, uint256 debt) = _state();
        return _freshHints(coll - amount, debt);
    }
}
