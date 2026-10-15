// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {PylonFlashEngine} from "../src/PylonFlashEngine.sol";
import {PylonPosition} from "../src/PylonPosition.sol";
import {PylonReserve} from "../src/PylonReserve.sol";
import {IMUSD, IERC20, IBorrowerOperations, IBorrowerOperationsSignatures, ITroveManager, ISortedTroves, IHintHelpers, IPriceFeed} from "../src/interfaces/IMezo.sol";
import {IPool, IPoolFactory, IRouter} from "../src/interfaces/ITigris.sol";
import {IERC20 as OZIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Deploy
/// @notice Deploys Pylon against live Mezo + Tigris infrastructure.
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $MEZO_TESTNET_RPC --private-key $PRIVATE_KEY --broadcast
///
/// Defaults target Mezo Testnet (chainId 31611). Every address can be overridden by env var so the
/// same script deploys to Mezo Mainnet (31612) once mainnet pools are wired.
contract Deploy is Script {
    struct Config {
        address musd;
        address btc;
        address flashPool;
        address swapPool;
        address router;
        address poolFactory;
        address borrowerOps;
        address borrowerOpsSignatures;
        address troveManager;
        address sortedTroves;
        address hintHelpers;
        address priceFeed;
    }

    function config() internal view returns (Config memory c) {
        uint256 chainId = block.chainid;
        if (chainId == 31611) {
            // Mezo Matsnet (testnet)
            c = Config({
                musd: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503,
                btc: 0x7b7C000000000000000000000000000000000000,
                flashPool: 0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e, // MUSD/mUSDC (stable, ~200k MUSD)
                swapPool: 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9, // MUSD/BTC (volatile, deep)
                router: 0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9,
                poolFactory: 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A,
                borrowerOps: 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5,
                borrowerOpsSignatures: 0xD757e3646AF370b15f32EB557F0F8380Df7D639e,
                troveManager: 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0,
                sortedTroves: 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA,
                hintHelpers: 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6,
                priceFeed: 0x86bCF0841622a5dAC14A313a15f96A95421b9366
            });
        } else if (chainId == 31612) {
            // Mezo Mainnet
            c = Config({
                musd: 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186,
                btc: 0x7b7C000000000000000000000000000000000000,
                flashPool: vm.envOr("FLASH_POOL", address(0)),
                swapPool: 0x52e604c44417233b6CcEDDDc0d640A405Caacefb, // MUSD/BTC (token0 = BTC)
                router: 0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706,
                poolFactory: 0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248,
                borrowerOps: 0x44b1bac67dDA612a41a58AAf779143B181dEe031,
                borrowerOpsSignatures: 0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a,
                troveManager: 0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193,
                sortedTroves: 0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f,
                hintHelpers: 0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3,
                priceFeed: 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88
            });
        } else {
            revert("unsupported chain: set addresses via env");
        }

        // env overrides (used for mainnet flash venue and for local dry runs)
        c.musd = vm.envOr("MUSD", c.musd);
        c.btc = vm.envOr("BTC", c.btc);
        c.flashPool = vm.envOr("FLASH_POOL", c.flashPool);
        c.swapPool = vm.envOr("SWAP_POOL", c.swapPool);
        c.router = vm.envOr("ROUTER", c.router);
        c.poolFactory = vm.envOr("POOL_FACTORY", c.poolFactory);
        c.borrowerOps = vm.envOr("BORROWER_OPS", c.borrowerOps);
        c.borrowerOpsSignatures = vm.envOr("BORROWER_OPS_SIGNATURES", c.borrowerOpsSignatures);
        c.troveManager = vm.envOr("TROVE_MANAGER", c.troveManager);
        c.sortedTroves = vm.envOr("SORTED_TROVES", c.sortedTroves);
        c.hintHelpers = vm.envOr("HINT_HELPERS", c.hintHelpers);
        c.priceFeed = vm.envOr("PRICE_FEED", c.priceFeed);
    }

    function run() external {
        Config memory c = config();
        require(c.flashPool != address(0), "flash pool not configured");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);

        console.log("chainId", block.chainid);
        console.log("deployer", deployer);
        console.log("flashPool", c.flashPool);
        console.log("swapPool", c.swapPool);

        vm.startBroadcast(pk);

        // 1. position implementation (cloned per user)
        PylonPosition positionImpl = new PylonPosition();
        console.log("PylonPosition impl", address(positionImpl));

        // 2. flash engine
        PylonFlashEngine engine = new PylonFlashEngine(
            deployer,
            IMUSD(c.musd),
            IERC20(c.btc),
            IPool(c.flashPool),
            IPool(c.swapPool),
            IRouter(c.router),
            IPoolFactory(c.poolFactory),
            IBorrowerOperations(c.borrowerOps),
            IBorrowerOperationsSignatures(c.borrowerOpsSignatures),
            ITroveManager(c.troveManager),
            ISortedTroves(c.sortedTroves),
            IHintHelpers(c.hintHelpers),
            IPriceFeed(c.priceFeed),
            treasury
        );
        console.log("PylonFlashEngine", address(engine));

        // 3. shield reserve
        PylonReserve reserve = new PylonReserve(deployer, OZIERC20(c.musd));
        console.log("PylonReserve", address(reserve));

        // 4. wire everything up
        engine.setPositionImplementation(address(positionImpl));
        reserve.setEngine(address(engine));
        engine.setReserve(address(reserve));

        vm.stopBroadcast();

        _writeDeployment(address(engine), address(reserve), address(positionImpl), c);
    }

    function _writeDeployment(address engine, address reserve, address positionImpl, Config memory c) internal {
        string memory obj = "pylon";
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");

        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "pylonFlashEngine", engine);
        vm.serializeAddress(obj, "pylonReserve", reserve);
        vm.serializeAddress(obj, "pylonPositionImplementation", positionImpl);
        vm.serializeAddress(obj, "musd", c.musd);
        vm.serializeAddress(obj, "btc", c.btc);
        vm.serializeAddress(obj, "flashPool", c.flashPool);
        vm.serializeAddress(obj, "swapPool", c.swapPool);
        vm.serializeAddress(obj, "router", c.router);
        vm.serializeAddress(obj, "poolFactory", c.poolFactory);
        vm.serializeAddress(obj, "borrowerOps", c.borrowerOps);
        vm.serializeAddress(obj, "borrowerOpsSignatures", c.borrowerOpsSignatures);
        vm.serializeAddress(obj, "troveManager", c.troveManager);
        vm.serializeAddress(obj, "sortedTroves", c.sortedTroves);
        vm.serializeAddress(obj, "hintHelpers", c.hintHelpers);
        vm.serializeAddress(obj, "priceFeed", c.priceFeed);
        string memory json = vm.serializeAddress(obj, "deployer", msg.sender);
        vm.writeJson(json, path);
        console.log("deployment written to", path);
    }
}
