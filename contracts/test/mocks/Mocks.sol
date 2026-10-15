// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, IMUSD} from "../../src/interfaces/IMezo.sol";
import {IPool, IPoolCallee, IPoolFactory, IRouter} from "../../src/interfaces/ITigris.sol";
import {PylonMath} from "../../src/libraries/PylonMath.sol";

/// @dev Minimal ERC-20 used for both MUSD and Mezo's BTC precompile stand-in.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from != msg.sender) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockPoolFactory {
    uint256 public defaultFeeBps = 30;
    mapping(address => uint256) public poolFeeBps;
    bool public isPaused;

    function getFee(address pool, bool) external view returns (uint256) {
        uint256 f = poolFeeBps[pool];
        return f == 0 ? defaultFeeBps : f;
    }

    function setFee(uint256 f) external {
        defaultFeeBps = f;
    }

    function setPoolFee(address pool, uint256 f) external {
        poolFeeBps[pool] = f;
    }

    function isPool(address) external pure returns (bool) {
        return true;
    }
}

/// @dev Volatile constant-product pool with the same optimistic-transfer + hook flow as Tigris.
contract MockPool is IPool {
    address public token0;
    address public token1;
    bool public stable;
    address public factory;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public blockTimestampLast;

    /// @dev Test knobs that model a misbehaving venue: one that returns without servicing the flash
    ///      callback, and one that hands the callback a payload for a different operation.
    bool public skipHook;
    bool public corruptOpByte;

    constructor(address t0, address t1, address factory_, bool stable_) {
        token0 = t0;
        token1 = t1;
        factory = factory_;
        stable = stable_;
    }

    function setReserves(uint256 r0, uint256 r1) external {
        reserve0 = r0;
        reserve1 = r1;
    }

    function setSkipHook(bool v) external {
        skipHook = v;
    }

    function setCorruptOpByte(bool v) external {
        corruptOpByte = v;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256) {
        bool inIsToken0 = tokenIn == token0;
        uint256 reserveIn = inIsToken0 ? reserve0 : reserve1;
        uint256 reserveOut = inIsToken0 ? reserve1 : reserve0;
        uint256 feeBps = MockPoolFactory(factory).getFee(address(this), stable);
        return PylonMath.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "no output");
        if (amount0Out > 0) MockERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockERC20(token1).transfer(to, amount1Out);
        if (skipHook) {
            // Models a venue that transfers the output and returns without servicing the flash.
            return;
        }
        if (data.length > 0) {
            if (corruptOpByte) {
                // `HookPayload.op` is the first field of the tuple: byte 32 + 31 of the encoded data.
                bytes memory mutated = data;
                mutated[63] = 0x63; // an op the engine never started
                IPoolCallee(to).hook(msg.sender, amount0Out, amount1Out, mutated);
            } else {
                IPoolCallee(to).hook(msg.sender, amount0Out, amount1Out, data);
            }
        }
        uint256 balance0 = MockERC20(token0).balanceOf(address(this));
        uint256 balance1 = MockERC20(token1).balanceOf(address(this));
        uint256 amount0In = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "no input");

        // Faithful Solidly-style invariant check: fees are raked off the input, then the
        // constant-product invariant must not decrease. This is what rejects under-repaid flashes.
        uint256 feeBps = MockPoolFactory(factory).getFee(address(this), stable);
        uint256 fee0 = (amount0In * feeBps) / 10_000;
        uint256 fee1 = (amount1In * feeBps) / 10_000;
        require(
            (balance0 - fee0) * (balance1 - fee1) >= reserve0 * reserve1,
            "K"
        );

        reserve0 = balance0;
        reserve1 = balance1;
    }
}

/// @dev Router that prices swaps off the live pool reserves with the same curve as Tigris.
contract MockRouter is IRouter {
    MockPool public pool;
    address public immutable factory;
    uint8 public feeBps = 30;

    constructor(MockPool pool_, address factory_) {
        pool = pool_;
        factory = factory_;
    }

    function setFeeBps(uint8 f) external {
        feeBps = f;
    }

    function setPool(MockPool pool_) external {
        pool = pool_;
    }

    function defaultFactory() external view returns (address) {
        return factory;
    }

    function poolFor(address, address, bool, address) external view returns (address) {
        return address(pool);
    }

    function getReserves(address, address, bool, address) external view returns (uint256, uint256) {
        return (pool.reserve0(), pool.reserve1());
    }

    function getAmountsOut(uint256 amountIn, Route[] memory routes) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        (uint256 r0, uint256 r1,) = pool.getReserves();
        bool inIsToken0 = routes[0].from == pool.token0();
        uint256 poolFee = MockPoolFactory(factory).getFee(address(pool), false);
        amounts[1] = PylonMath.getAmountOut(amountIn, inIsToken0 ? r0 : r1, inIsToken0 ? r1 : r0, poolFee);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired");
        (uint256 r0, uint256 r1,) = pool.getReserves();
        bool inIsToken0 = routes[0].from == pool.token0();
        uint256 reserveIn = inIsToken0 ? r0 : r1;
        uint256 reserveOut = inIsToken0 ? r1 : r0;
        uint256 poolFeeBps = MockPoolFactory(factory).getFee(address(pool), false);
        uint256 out = PylonMath.getAmountOut(amountIn, reserveIn, reserveOut, poolFeeBps);
        require(out >= amountOutMin, "insufficient output");

        // route through the pool exactly like the real router: push the input in, let the pool
        // perform the optimistic output transfer and recompute its own reserves.
        MockERC20(routes[0].from).transferFrom(msg.sender, address(pool), amountIn);
        if (inIsToken0) {
            pool.swap(0, out, to, "");
        } else {
            pool.swap(out, 0, to, "");
        }

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}

contract MockPriceFeed {
    uint256 public price = 100_000e18;

    function fetchPrice() external view returns (uint256) {
        return price;
    }

    function setPrice(uint256 p) external {
        price = p;
    }
}

contract MockTroveManager {
    struct Trove {
        uint256 coll;
        uint256 debt;
        uint8 status;
    }

    mapping(address => Trove) public troves;

    function setTrove(address who, uint256 coll, uint256 debt, uint8 status) external {
        troves[who] = Trove(coll, debt, status);
    }

    function getTroveStatus(address who) external view returns (uint8) {
        return troves[who].status;
    }

    function getTroveColl(address who) external view returns (uint256) {
        return troves[who].coll;
    }

    function getTroveDebt(address who) external view returns (uint256) {
        return troves[who].debt;
    }

    function getTrovePrincipal(address who) external view returns (uint256) {
        return troves[who].debt;
    }

    function getTroveInterestOwed(address) external pure returns (uint256) {
        return 0;
    }

    function getTroveInterestRate(address) external pure returns (uint16) {
        return 100;
    }

    function getTroveLastInterestUpdateTime(address) external pure returns (uint256) {
        return 0;
    }

    function getCurrentICR(address who, uint256 price) external view returns (uint256) {
        Trove memory t = troves[who];
        if (t.debt == 0) return type(uint256).max;
        return (t.coll * price) / t.debt;
    }

    function getNominalICR(address who) external view returns (uint256) {
        Trove memory t = troves[who];
        if (t.debt == 0) return type(uint256).max;
        return (t.coll * 1e20) / t.debt;
    }

    function getEntireDebtAndColl(address who) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        Trove memory t = troves[who];
        return (t.coll, t.debt, 0, 0, 0, 0);
    }

    function getTCR(uint256) external pure returns (uint256) {
        return 4e18;
    }

    function checkRecoveryMode(uint256) external pure returns (bool) {
        return false;
    }

    function updateSystemInterest() external {}

    function updateSystemAndTroveInterest(address) external {}

    function MCR() external pure returns (uint256) {
        return 1.1e18;
    }

    function CCR() external pure returns (uint256) {
        return 1.5e18;
    }
}

/// @dev BorrowerOperations stand-in with Mezo's exact token-flow semantics.
contract MockBorrowerOps {
    uint256 public constant MUSD_GAS_COMPENSATION = 200e18;
    uint256 public minNetDebt = 1_800e18;
    uint256 public borrowingRateBps = 10; // 0.10%

    IMUSD public musd;
    MockTroveManager public troveManager;
    MockERC20 public btc;

    constructor(IMUSD musd_, MockTroveManager tm_, MockERC20 btc_) {
        musd = musd_;
        troveManager = tm_;
        btc = btc_;
    }

    function getBorrowingFee(uint256 debt) external view returns (uint256) {
        return (debt * borrowingRateBps) / 10_000;
    }

    function openTrove(uint256 debtAmount, address, address) external payable {
        require(debtAmount >= minNetDebt, "min net debt");
        musd.mint(msg.sender, debtAmount);
        troveManager.setTrove(
            msg.sender,
            troveManager.getTroveColl(msg.sender) + msg.value,
            troveManager.getTroveDebt(msg.sender) + debtAmount + MUSD_GAS_COMPENSATION,
            1
        );
    }

    function addColl(address, address) external payable {
        _adjust(msg.sender, 0, 0, false);
    }

    function adjustTrove(uint256 collWithdrawal, uint256 debtChange, bool isDebtIncrease, address, address) external payable {
        _adjust(msg.sender, collWithdrawal, debtChange, isDebtIncrease);
    }

    function withdrawColl(uint256 amount, address, address) external {
        _adjust(msg.sender, amount, 0, false);
    }

    function repayMUSD(uint256 amount, address, address) external {
        _adjust(msg.sender, 0, amount, false);
    }

    function closeTrove() external {
        uint256 debt = troveManager.getTroveDebt(msg.sender);
        uint256 coll = troveManager.getTroveColl(msg.sender);
        require(musd.balanceOf(msg.sender) >= debt - MUSD_GAS_COMPENSATION, "insufficient musd");
        musd.burn(msg.sender, debt - MUSD_GAS_COMPENSATION);
        btc.mint(msg.sender, coll); // stand-in for ActivePool.sendCollateral
        troveManager.setTrove(msg.sender, 0, 0, 2);
    }

    function _adjust(address who, uint256 collWithdrawal, uint256 debtChange, bool isDebtIncrease) internal {
        uint256 coll = troveManager.getTroveColl(who);
        uint256 debt = troveManager.getTroveDebt(who);
        if (isDebtIncrease) {
            musd.mint(who, debtChange);
            troveManager.setTrove(who, coll + msg.value, debt + debtChange + (debtChange * borrowingRateBps) / 10_000, 1);
            return;
        }
        if (debtChange > 0) {
            require(musd.balanceOf(who) >= debtChange, "insufficient musd");
            musd.burn(who, debtChange);
            debt -= debtChange;
        }
        if (collWithdrawal > 0) {
            btc.mint(who, collWithdrawal); // stand-in for ActivePool.sendCollateral
            coll -= collWithdrawal;
        }
        coll += msg.value;
        troveManager.setTrove(who, coll, debt, debt == 0 ? 2 : 1);
    }
}

/// @dev Mirrors BorrowerOperationsSignatures' observable behaviour: burns from itself on repay and
///      close, and applies the trove change through BorrowerOperations semantics.
contract MockBorrowerOpsSignatures {
    IMUSD public musd;
    MockBorrowerOps public borrowerOps;
    MockTroveManager public troveManager;
    MockERC20 public btc;
    mapping(address => uint256) public nonces;

    constructor(IMUSD musd_, MockBorrowerOps bo_, MockTroveManager tm_, MockERC20 btc_) {
        musd = musd_;
        borrowerOps = bo_;
        troveManager = tm_;
        btc = btc_;
    }

    function adjustTroveWithSignature(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address,
        address,
        address borrower,
        address recipient,
        bytes calldata,
        uint256
    ) external payable {
        nonces[borrower]++;
        uint256 coll = troveManager.getTroveColl(borrower);
        uint256 debt = troveManager.getTroveDebt(borrower);

        if (isDebtIncrease) {
            musd.mint(recipient, debtChange);
            troveManager.setTrove(
                borrower,
                coll + msg.value,
                debt + debtChange + (debtChange * borrowerOps.borrowingRateBps()) / 10_000,
                1
            );
            return;
        }
        // Repay path: Mezo's helper forwards its caller (the engine) as the repayment caller, so the
        // burn happens from msg.sender — this mirrors the deployed behaviour exactly.
        require(musd.balanceOf(msg.sender) >= debtChange, "BorrowerOps: Caller doesnt have enough mUSD to make repayment");
        musd.burn(msg.sender, debtChange);
        debt -= debtChange;
        if (collWithdrawal > 0) {
            btc.mint(recipient, collWithdrawal); // stand-in for ActivePool.sendCollateral
            coll -= collWithdrawal;
        }
        troveManager.setTrove(borrower, coll, debt, debt == 0 ? 2 : 1);
    }

    function closeTroveWithSignature(address borrower, address recipient, bytes calldata, uint256) external {
        uint256 debt = troveManager.getTroveDebt(borrower);
        uint256 coll = troveManager.getTroveColl(borrower);
        uint256 burnAmount = debt - borrowerOps.MUSD_GAS_COMPENSATION();
        require(musd.balanceOf(msg.sender) >= burnAmount, "BorrowerOps: Caller doesnt have enough mUSD to make repayment");
        musd.burn(msg.sender, burnAmount);
        btc.mint(recipient, coll); // stand-in for ActivePool.sendCollateral
        troveManager.setTrove(borrower, 0, 0, 2);
    }
}

contract MockHintHelpers {
    function getApproxHint(uint256, uint256, uint256) external view returns (address, uint256, uint256) {
        return (address(0), 0, 0);
    }

    function computeNominalCR(uint256 coll, uint256 debt) external pure returns (uint256) {
        return debt == 0 ? type(uint256).max : (coll * 1e20) / debt;
    }

    function computeCR(uint256 coll, uint256 debt, uint256 price) external pure returns (uint256) {
        return debt == 0 ? type(uint256).max : (coll * price) / debt;
    }
}

contract MockSortedTroves {
    function contains(address) external pure returns (bool) {
        return true;
    }

    function getSize() external pure returns (uint256) {
        return 0;
    }

    function getFirst() external pure returns (address) {
        return address(0);
    }

    function getLast() external pure returns (address) {
        return address(0);
    }

    function getNext(address) external pure returns (address) {
        return address(0);
    }

    function getPrev(address) external pure returns (address) {
        return address(0);
    }

    function validInsertPosition(uint256, address, address) external pure returns (bool) {
        return true;
    }

    function findInsertPosition(uint256, address, address) external pure returns (address, address) {
        return (address(0), address(0));
    }
}
