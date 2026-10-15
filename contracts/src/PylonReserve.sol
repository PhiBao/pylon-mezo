// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPylonPosition, IPylonReserve} from "./interfaces/IPylon.sol";

/// @title PylonReserve
/// @notice The shield pool: a MUSD-denominated, share-based liquidity reserve that earns the
///         origination fee on every Pylon flash and lends capital for exactly one purpose —
///         repaying the debt of a Pylon position that has fallen into its defence band.
///
/// @dev Economics
///      - Depositors receive shares priced on `totalAssets() = idle MUSD + outstanding defence loans`.
///      - Flash fees are pushed into the reserve, so the share price rises without rebalancing.
///      - Outflows are hard-capped: per call, per position, and against total assets (utilization
///        cap). Loans are only issuable to positions created by the engine, and are callable by
///        those positions alone.
///      - Borrowers settle loans through `PylonPosition.repayReserve`, which transfers MUSD here and
///        books the repayment. A position cannot release collateral while a loan is outstanding, so
///        the reserve's claim is enforced in code.
contract PylonReserve is IPylonReserve, Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    IERC20 public immutable musd;

    /// @notice Pylon engine allowed to register positions and report fees.
    address public engine;

    uint256 public totalShares;

    mapping(address => uint256) public shares;

    /// @notice MUSD lent to positions and not yet settled.
    uint256 public outstanding;

    /// @notice Per-position defence loans.
    mapping(address => uint256) public loans;

    mapping(address => bool) public positions;

    /// @notice Lifetime flash fees received, for reporting.
    uint256 public feesReceived;

    /// @notice Absolute MUSD ceiling for a single defence call.
    uint256 public maxLendPerCall = 25_000e18;

    /// @notice Absolute MUSD ceiling of concurrent defence debt per position.
    uint256 public maxLendPerPosition = 100_000e18;

    /// @notice Maximum share of total assets that may be lent out, in basis points.
    uint256 public utilizationCapBps = 9_000;

    /// @notice Maximum share of total assets a single position may hold, in basis points. Without it
    ///         one borrower can occupy the whole reserve, which denies every other position a defence.
    uint256 public maxPerPositionBps = 2_000;

    /// @notice Fee withheld when a defence loan is issued, in basis points of the loan. The position
    ///         owes the full amount and receives the remainder, so the reserve prices the credit
    ///         without an interest-accrual model.
    uint256 public defenceFeeBps = 50;

    /// @notice Hard ceiling for the defence fee.
    uint256 public constant MAX_DEFENCE_FEE_BPS = 500;

    /// @notice Virtual shares and assets used in the share maths (the ERC-4626 virtual-offset form).
    ///         They keep the share price defined for the first depositor and make a donation attack
    ///         cost more than the deposit it tries to block, without changing the 1:1 unit that the
    ///         interface reports.
    uint256 public constant VIRTUAL_SHARES = 1;
    uint256 public constant VIRTUAL_ASSETS = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed depositor, address indexed receiver, uint256 assets, uint256 sharesMinted);
    event Withdrawn(address indexed owner, address indexed receiver, uint256 sharesBurned, uint256 assets);
    event FeeReceived(address indexed from, uint256 amount);
    event Lent(address indexed position, uint256 amount, uint256 totalOutstanding);
    event Repaid(address indexed position, uint256 amount, uint256 remaining);
    event PositionRegistered(address indexed position);
    event LoanWrittenOff(address indexed position, uint256 amount, uint256 remaining);
    event LimitsUpdated(uint256 maxLendPerCall, uint256 maxLendPerPosition, uint256 utilizationCapBps);
    event ConcentrationUpdated(uint256 maxPerPositionBps, uint256 defenceFeeBps);
    event EngineUpdated(address indexed engine);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotEngine();
    error NotPosition();
    error NotShareOwner();
    error CapExceeded();
    error UtilizationExceeded();
    error OutstandingLoans();
    error FeeTooHigh();
    error InsufficientLiquidity();
    error NothingToRepay();

    constructor(address owner_, IERC20 musd_) Ownable(owner_) {
        if (address(musd_) == address(0)) revert ZeroAddress();
        musd = musd_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    /// @dev A handover is refused while defence loans are outstanding. Positions read the reserve
    ///      through the engine, so re-pointing the engine at a different reserve while loans are live
    ///      would leave those loans unpayable and their collateral permanently locked.
    function setEngine(address engine_) external onlyOwner {
        if (engine_ == address(0)) revert ZeroAddress();
        if (outstanding != 0) revert OutstandingLoans();
        engine = engine_;
        emit EngineUpdated(engine_);
    }

    function setConcentration(uint256 maxPerPositionBps_, uint256 defenceFeeBps_) external onlyOwner {
        if (defenceFeeBps_ > MAX_DEFENCE_FEE_BPS) revert FeeTooHigh();
        if (maxPerPositionBps_ > 10_000) revert CapExceeded();
        maxPerPositionBps = maxPerPositionBps_;
        defenceFeeBps = defenceFeeBps_;
        emit ConcentrationUpdated(maxPerPositionBps_, defenceFeeBps_);
    }

    function setLimits(uint256 maxLendPerCall_, uint256 maxLendPerPosition_, uint256 utilizationCapBps_) external onlyOwner {
        if (utilizationCapBps_ > 9_500) revert CapExceeded();
        maxLendPerCall = maxLendPerCall_;
        maxLendPerPosition = maxLendPerPosition_;
        utilizationCapBps = utilizationCapBps_;
        emit LimitsUpdated(maxLendPerCall_, maxLendPerPosition_, utilizationCapBps_);
    }

    /// @notice Sweeps tokens other than MUSD (MUSD is the accounting asset and cannot be swept).
    function sweep(address token, address to) external onlyOwner {
        if (token == address(musd) || to == address(0)) revert ZeroAddress();
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }

    function registerPosition(address position) external override {
        if (msg.sender != engine) revert NotEngine();
        if (position == address(0)) revert ZeroAddress();
        positions[position] = true;
        emit PositionRegistered(position);
    }

    // ---------------------------------------------------------------------
    // Lender side
    // ---------------------------------------------------------------------

    function totalAssets() public view override returns (uint256) {
        return musd.balanceOf(address(this)) + outstanding;
    }

    function idleLiquidity() public view returns (uint256) {
        return musd.balanceOf(address(this));
    }

    /// @notice Shares minted for `assets` at the pool's current price.
    /// @dev Uses the virtual-share offset so the price is defined before the first deposit.
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 total = totalAssets();
        return (assets * (totalShares + VIRTUAL_SHARES)) / (total + VIRTUAL_ASSETS);
    }

    /// @notice Assets redeemable for `shareBalance` at the pool's current price.
    function convertToAssets(uint256 shareBalance) public view returns (uint256) {
        return (shareBalance * (totalAssets() + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
    }

    /// @notice Value of one whole share at the pool's current price, the unit the interface reports.
    function sharePrice() external view returns (uint256) {
        return convertToAssets(1e18);
    }

    /// @notice Deposits MUSD and mints shares to `receiver`.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 sharesMinted) {
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();

        // The price must be read *before* the deposit lands. `convertToShares` reads `totalAssets()`
        // from the live balance, so calling it after `transferFrom` would count the depositor's own
        // MUSD in the total and mint them fewer shares than they paid for — the loss going to earlier
        // holders. The pre-transfer total is therefore snapshotted here and the shares are computed
        // from it.
        uint256 before = musd.balanceOf(address(this));
        uint256 totalBefore = before + outstanding;
        musd.transferFrom(msg.sender, address(this), assets);
        uint256 received = musd.balanceOf(address(this)) - before;

        sharesMinted = (received * (totalShares + VIRTUAL_SHARES)) / (totalBefore + VIRTUAL_ASSETS);
        if (sharesMinted == 0) revert ZeroAmount();
        totalShares += sharesMinted;
        shares[receiver] += sharesMinted;
        emit Deposited(msg.sender, receiver, received, sharesMinted);
    }

    /// @notice Redeems shares for idle MUSD. Utilization can temporarily delay withdrawals — the
    ///         interface surfaces "available now" so this is never a surprise.
    function withdraw(uint256 shareAmount, address receiver, address shareOwner) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        if (msg.sender != shareOwner) {
            // no allowance plumbing: shares are not transferable, so only the owner may redeem
            revert NotShareOwner();
        }
        if (shareAmount == 0) revert ZeroAmount();
        assets = convertToAssets(shareAmount);
        if (assets > idleLiquidity()) revert InsufficientLiquidity();
        shares[shareOwner] -= shareAmount;
        totalShares -= shareAmount;
        musd.transfer(receiver, assets);
        emit Withdrawn(shareOwner, receiver, shareAmount, assets);
    }

    /// @notice Maximum MUSD the reserve will currently lend to `position`.
    /// @dev Four independent ceilings: per call, per position, per position as a share of total
    ///      assets, and utilisation of total assets.
    function availableToLend(address position) public view override returns (uint256) {
        if (!positions[position]) return 0;
        uint256 idle = idleLiquidity();
        uint256 assets = totalAssets();

        uint256 allowedByUtilization = (assets * utilizationCapBps) / 10_000;
        if (outstanding >= allowedByUtilization) return 0;
        uint256 roomAsset = allowedByUtilization - outstanding;

        uint256 allowedByConcentration = (assets * maxPerPositionBps) / 10_000;
        if (loans[position] >= allowedByConcentration) return 0;
        uint256 roomConcentration = allowedByConcentration - loans[position];

        uint256 loanRoom = loans[position] >= maxLendPerPosition ? 0 : maxLendPerPosition - loans[position];

        uint256 cap = maxLendPerCall;
        if (roomAsset < cap) cap = roomAsset;
        if (roomConcentration < cap) cap = roomConcentration;
        if (loanRoom < cap) cap = loanRoom;
        if (idle < cap) cap = idle;
        return cap;
    }

    // ---------------------------------------------------------------------
    // Borrower side (positions only)
    // ---------------------------------------------------------------------

    /// @notice Funds a defence repayment for the calling position. The reserve can only ever pay
    ///         MUSD to a registered position; the position decides how it is spent, and both the
    ///         position's code and its policy restrict that spending to debt reduction.
    function lendTo(uint256 amount) external override nonReentrant {
        if (!positions[msg.sender]) revert NotPosition();
        if (amount == 0) revert ZeroAmount();
        if (amount > maxLendPerCall) revert CapExceeded();
        if (loans[msg.sender] + amount > maxLendPerPosition) revert CapExceeded();

        uint256 assets = totalAssets();
        if (outstanding + amount > (assets * utilizationCapBps) / 10_000) revert UtilizationExceeded();
        if (loans[msg.sender] + amount > (assets * maxPerPositionBps) / 10_000) {
            revert UtilizationExceeded();
        }
        if (amount > idleLiquidity()) revert InsufficientLiquidity();

        // The position owes the full amount and receives it less the defence fee, so the reserve earns
        // its spread from the first second of the loan instead of relying on an accrual model.
        // Rounded up for the same reason as the origination fee: a floor would make small defence
        // loans free and let a borrower split a defence to avoid paying for the capital.
        uint256 fee = defenceFeeBps == 0 ? 0 : (amount * defenceFeeBps + 9_999) / 10_000;
        loans[msg.sender] += amount;
        outstanding += amount;
        musd.transfer(msg.sender, amount - fee);
        if (fee > 0) {
            feesReceived += fee;
            emit FeeReceived(msg.sender, fee);
        }
        emit Lent(msg.sender, amount, outstanding);
    }

    /// @notice Writes off a defence loan that cannot be repaid, for example after the position's trove
    ///         was liquidated. The loss is removed from `outstanding`, so `totalAssets()` stops
    ///         counting assets the pool no longer holds and the share price falls immediately instead
    ///         of quietly overstating every later deposit.
    ///         Governance must only call this once the trove is provably closed.
    function writeOffLoan(address position, uint256 amount) external onlyOwner {
        uint256 loan = loans[position];
        uint256 applied = amount > loan ? loan : amount;
        if (applied == 0) revert NothingToRepay();
        loans[position] = loan - applied;
        outstanding -= applied;
        // Clear the mirror on the position too, so a written-off loan cannot leave it permanently
        // unable to withdraw its collateral. Best effort: the position may already be gone.
        try IPylonPosition(position).writeOffReserveDebt(applied) {} catch {}
        emit LoanWrittenOff(position, applied, loans[position]);
    }

    /// @notice Books a repayment already transferred in by the calling position.
    function recordRepayment(uint256 amount) external override nonReentrant {
        if (!positions[msg.sender]) revert NotPosition();
        if (amount == 0) revert ZeroAmount();
        uint256 loan = loans[msg.sender];
        uint256 applied = amount > loan ? loan : amount;
        if (applied == 0) revert NothingToRepay();
        loans[msg.sender] = loan - applied;
        outstanding -= applied;
        emit Repaid(msg.sender, applied, loans[msg.sender]);
    }

    /// @notice Registers flash origination fees pushed in by the engine.
    function notifyFee(uint256 amount) external override {
        if (msg.sender != engine) revert NotEngine();
        feesReceived += amount;
        emit FeeReceived(msg.sender, amount);
    }
}
