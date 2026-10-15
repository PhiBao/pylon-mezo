// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPylonReserve} from "./interfaces/IPylon.sol";

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

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed depositor, address indexed receiver, uint256 assets, uint256 sharesMinted);
    event Withdrawn(address indexed owner, address indexed receiver, uint256 sharesBurned, uint256 assets);
    event FeeReceived(address indexed from, uint256 amount);
    event Lent(address indexed position, uint256 amount, uint256 totalOutstanding);
    event Repaid(address indexed position, uint256 amount, uint256 remaining);
    event PositionRegistered(address indexed position);
    event LimitsUpdated(uint256 maxLendPerCall, uint256 maxLendPerPosition, uint256 utilizationCapBps);
    event EngineUpdated(address indexed engine);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotEngine();
    error NotPosition();
    error NotPositionOwner();
    error CapExceeded();
    error UtilizationExceeded();
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

    function setEngine(address engine_) external onlyOwner {
        if (engine_ == address(0)) revert ZeroAddress();
        engine = engine_;
        emit EngineUpdated(engine_);
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

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalShares;
        uint256 total = totalAssets();
        if (supply == 0 || total == 0) return assets;
        return (assets * supply) / total;
    }

    function convertToAssets(uint256 shareBalance) public view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) return shareBalance;
        return (shareBalance * totalAssets()) / supply;
    }

    /// @notice Deposits MUSD and mints shares to `receiver`.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 sharesMinted) {
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        uint256 before = musd.balanceOf(address(this));
        musd.transferFrom(msg.sender, address(this), assets);
        uint256 received = musd.balanceOf(address(this)) - before;
        sharesMinted = convertToShares(received);
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
            revert NotPositionOwner();
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
    function availableToLend(address position) public view override returns (uint256) {
        if (!positions[position]) return 0;
        uint256 idle = idleLiquidity();
        uint256 allowedByUtilization = (totalAssets() * utilizationCapBps) / 10_000;
        if (outstanding >= allowedByUtilization) return 0;
        uint256 roomAsset = allowedByUtilization - outstanding;
        uint256 loanRoom = loans[position] >= maxLendPerPosition ? 0 : maxLendPerPosition - loans[position];
        uint256 cap = maxLendPerCall;
        if (roomAsset < cap) cap = roomAsset;
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
        uint256 allowed = (totalAssets() * utilizationCapBps) / 10_000;
        if (outstanding + amount > allowed) revert UtilizationExceeded();
        if (amount > idleLiquidity()) revert InsufficientLiquidity();

        loans[msg.sender] += amount;
        outstanding += amount;
        musd.transfer(msg.sender, amount);
        emit Lent(msg.sender, amount, outstanding);
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
