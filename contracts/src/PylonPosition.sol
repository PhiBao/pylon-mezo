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

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    function initialize(address owner_, address engine_) external override {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || engine_ == address(0)) revert ZeroAddress();

        owner = owner_;
        engine = engine_;

        IPylonEngine e = IPylonEngine(engine_);
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
        if (received > 0) musd.transfer(owner, received);
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
            if (gained > 0) musd.transfer(owner, gained);
        }
    }

    /// @notice Repays debt from MUSD the position already holds.
    function repay(uint256 amount) external onlyOwner nonReentrant {
        (address upper, address lower) = _hintsForRepay(amount);
        borrowerOps.repayMUSD(amount, upper, lower);
    }

    /// @notice Withdraws collateral. Blocked while a reserve defence loan is outstanding, so the
    ///         shield's claim is always settled before collateral leaves the position.
    function withdrawCollateral(uint256 amount, address to) external onlyOwner nonReentrant {
        if (reserveDebt != 0) revert ReserveDebtOutstanding();
        (address upper, address lower) = _hintsForWithdraw(amount);
        uint256 before = btc.balanceOf(address(this));
        borrowerOps.withdrawColl(amount, upper, lower);
        uint256 gained = btc.balanceOf(address(this)) - before;
        if (gained > 0) btc.transfer(to, gained);
        emit CollateralWithdrawn(gained, to);
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
        if (enabled && (targetICR <= triggerICR || triggerICR < 1.1e18)) revert BadShieldConfig();
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
        uint256 coll = troveManager.getTroveColl(address(this));
        uint256 debt = troveManager.getTroveDebt(address(this));
        uint256 icr = PylonMath.collateralRatio(coll, debt, price);
        if (icr >= p.triggerICR) revert Healthy();

        uint256 maxDebtAtTarget = PylonMath.debtAtRatio(coll, price, p.targetICR);
        uint256 want = debt > maxDebtAtTarget ? debt - maxDebtAtTarget : 0;
        if (want == 0) revert NothingToRepay();
        if (want > p.maxPerCall) want = p.maxPerCall;

        IPylonReserve r = IPylonReserve(engine_reserve());
        uint256 available = r.availableToLend(address(this));
        repaid = want < available ? want : available;
        if (repaid == 0) revert NothingToRepay();

        r.lendTo(repaid);
        reserveDebt += repaid;

        (address upper, address lower) = _hintsForRepay(repaid);
        borrowerOps.repayMUSD(repaid, upper, lower);

        uint256 postICR = PylonMath.collateralRatio(coll, debt - repaid, price);
        if (postICR <= icr) revert NoImprovement();
        emit Defended(repaid, icr, postICR, reserveDebt);
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

        uint256 coll = troveManager.getTroveColl(address(this));
        uint256 debt = troveManager.getTroveDebt(address(this));
        uint256 newColl = isDebtIncrease ? coll + msg.value : coll - collWithdrawal;
        uint256 newDebt = isDebtIncrease ? debt + debtChange + _borrowingFee(debtChange) : debt - debtChange;
        (address upper, address lower) = _hints(newColl, newDebt, upperHint, lowerHint);

        uint256 musdBefore = musd.balanceOf(address(this));
        uint256 btcBefore = btc.balanceOf(address(this));

        borrowerOps.adjustTrove{value: msg.value}(collWithdrawal, debtChange, isDebtIncrease, upper, lower);

        uint256 musdGain = musd.balanceOf(address(this)) - musdBefore;
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

    function reserve() external view override returns (address) {
        return engine_reserve();
    }

    /// @dev The reserve address is read from the engine on demand so a single `setReserve` call on
    ///      the engine re-points every position at once.
    function engine_reserve() internal view returns (address) {
        return IPylonEngine(engine).reserve();
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
