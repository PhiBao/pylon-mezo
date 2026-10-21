# Pylon — Mezo mainnet runbook

Everything here is staged. The deployment is one command once the deployer holds a rounding error's
worth of BTC on mainnet.

```
chain            31612 (Mezo mainnet)
deployer         0x3bEe06fA351E66e298eF4DDcbE6052770775a93e   (key in contracts/.env)
RPC              https://jsonrpc-mezo.boar.network  (or https://mainnet.mezo.public.validationcloud.io)
gas price        0.0014625 gwei  →  the full deployment costs ≈1.4 MUSD (0.000017 BTC)
```

## 0. Before the first broadcast

```bash
cd contracts
set -a && . ./.env && set +a          # PRIVATE_KEY, MEZO_TESTNET_RPC
export MAINNET_RPC=https://jsonrpc-mezo.boar.network
export PRIVATE_KEY=$PRIVATE_KEY

# 1. confirm the deployer is funded (needs ≈0.00002 BTC)
cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $MAINNET_RPC

# 2. re-verify the network (MUSD, ledger, trove stack, signature helper, venues)
./script/verify-mainnet.sh $MAINNET_RPC

# 3. pre-flight: simulate the deployment (no broadcast, no cost)
forge script script/Deploy.s.sol:Deploy --rpc-url $MAINNET_RPC --private-key $PRIVATE_KEY
```

Step 3 has already been run against mainnet and passes: the constructor assertions hold
(`router.defaultFactory() == swapPool.factory()`, the pool token ordering, the stable flag) and the
simulated addresses are `0xCB33f384…` (position template), `0x0bafCB6C…` (engine),
`0xcc9dD719…` (reserve).

## 1. Deploy

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $MAINNET_RPC --private-key $PRIVATE_KEY --broadcast
```

This deploys the three audited contracts, wires them (`engine.setPositionImplementation`,
`reserve.setEngine`, `engine.setReserve`) and writes `contracts/deployments/31612.json` with the real
transaction hashes.

## 2. Verify

```bash
ENGINE=$(jq -r .pylonFlashEngine contracts/deployments/31612.json)
RESERVE=$(jq -r .pylonReserve contracts/deployments/31612.json)

cast call $ENGINE "reserve()(address)"                --rpc-url $MAINNET_RPC   # == the reserve
cast call $RESERVE "engine()(address)"                --rpc-url $MAINNET_RPC   # == the engine
cast call $ENGINE "positionImplementation()(address)" --rpc-url $MAINNET_RPC
cast call $ENGINE "flashFeeBps()(uint256)"            --rpc-url $MAINNET_RPC   # 20
cast call $ENGINE "maxExitSlippageBps()(uint256)"     --rpc-url $MAINNET_RPC   # 800
cast call $RESERVE "defenceFeeBps()(uint256)"         --rpc-url $MAINNET_RPC   # 50
cast call $RESERVE "maxPerPositionBps()(uint256)"     --rpc-url $MAINNET_RPC   # 2000
```

The same two invariants the audit added are the ones to watch: the reserve and the engine point at
each other, and every position captures its reserve at creation — so neither can be re-pointed out
from under an open claim.

## 3. Put real MUSD through it

Native BTC can be sold for MUSD on the mainnet MUSD/BTC pool (the BTC precompile implements
`transferFrom`, and the router has `swapExactETHForTokens`):

```bash
BTC=0x7b7C000000000000000000000000000000000000
MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
ROUTER=0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706
FACTORY=0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248
DEADLINE=$(( $(date +%s) + 1200 ))

# buy 20 MUSD with 0.0003 BTC (the pool charges 30 bps)
cast send $ROUTER "swapExactETHForTokens(uint256,(address,address,bool,address)[],address,uint256)" \
  19900000000000000000 "[($BTC,$MUSD,false,$FACTORY)]" $(cast wallet address --private-key $PRIVATE_KEY) $DEADLINE \
  --value 300000000000000 --private-key $PRIVATE_KEY --rpc-url $MAINNET_RPC --legacy

# deposit it into the reserve: shares are minted against the pre-transfer total
cast send $MUSD "approve(address,uint256)(bool)" $RESERVE 20000000000000000000 \
  --private-key $PRIVATE_KEY --rpc-url $MAINNET_RPC --legacy
cast send $RESERVE "deposit(uint256,address)(uint256)" 20000000000000000000 $(cast wallet address --private-key $PRIVATE_KEY) \
  --private-key $PRIVATE_KEY --rpc-url $MAINNET_RPC --legacy
```

This is the live proof of the audit's highest-severity economic fix: the second depositor's shares are
worth what they paid (`reserve.convertToAssets(shares) == 20e18`), where the audited code returned
roughly half.

## 4. Escape routes — the money is always reachable

The requirement was that a future contract generation can never strand capital. Three routes exist,
and all three are covered by regression tests in `contracts/test/Pylon.t.sol`.

**A. Move the pool to a new generation** (`test_capitalCanMoveToANewGeneration`)

1. Settle every live claim: the position owner calls `repayReserve(amount)` after sending the MUSD to
   the position. (`outstanding` must be 0 — `reserve.setEngine` refuses a handover otherwise, by
   design.)
2. Depositors withdraw: `reserve.withdraw(shares, receiver, shareOwner)`.
3. Deploy the successor: `forge script script/Deploy.s.sol:Deploy --broadcast` (the deployer nonce
   moves on, so the new generation gets fresh addresses).
4. Wire it: `newReserve.setEngine(newEngine)`, `newEngine.setReserve(newReserve)`,
   `newEngine.setPositionImplementation(newTemplate)`.
5. Depositors re-deposit into the new reserve.

Positions created before the migration keep their own implementation and their own captured reserve, so
they stay settleable and releasable — that is the property the audit added (finding M4). The old
engine keeps working; it only routes new fees wherever `setReserve` points.

**B. A borrower who never repays** (`test_stuckPositionIsReleasedByWriteOff`)

`reserve.writeOffLoan(position, amount)` books the loss, clears the position's mirror, and the owner
can then release the collateral with `withdrawCollateral`. Without the mirror clearing, the position
would have been locked forever — that was finding L3.

**C. Funds sent to the engine by mistake** (`test_engine_rescueMovesStrayFundsOnly`)

`engine.rescueToken(token, to, amount)` (owner only, refused while a flash is in flight). The engine
holds no MUSD or BTC between operations — every leg is delta-accounted and the residue is swept to
the beneficiary, and the tests assert the engine is empty after a loop, an unwind and an exit — so the
rescue can only ever reach funds that were sent by mistake.

**D. A liquidated position's surplus**

`position.claimCollateralSurplus()` releases the collateral Mezo owes the trove, to the owner once the
reserve's claim is settled.

## 5. Pointing the service and the terminal at mainnet

The judge-facing terminal stays on testnet. A mainnet instance is a second configuration, not a
change to the existing one:

```bash
# service
cd server
CHAIN_ID=31612
RPC_URL=https://jsonrpc-mezo.boar.network
DEPLOYMENT=../contracts/deployments/31612.json
X402_PAY_TO=<your mainnet address>
POSITIONS=<position addresses on mainnet, if any>
AUTO_DEFEND=0        # keep the keeper off until it has its own key
# .env is read at start; a separate .env.mainnet keeps the two apart

# terminal (static export; the API base and the chain id are build-time)
cd ../web
NEXT_PUBLIC_MEZO_RPC=https://jsonrpc-mezo.boar.network
NEXT_PUBLIC_BASE_PATH=/pylon-mezo
pnpm build
```

The terminal's chain id, explorer links, address set and the `x402` network string are all
build-time constants in `web/src/lib/chain.ts` and the panels that display them; switching networks
means switching those together with the deployment file.

## 6. Ownership and keys — still to do before third-party money

* The deployer key owns the engine and the reserve. It is a **different key from the testnet one**
  (the mainnet key lives in the repository root `.env`, the testnet key in `contracts/.env`), which is
  the right shape — but it has been used in plaintext during setup, so **rotate the owner to a fresh
  key** (ideally a hardware wallet) before any third-party money:

  ```bash
  cast send $ENGINE "transferOwnership(address)" $NEW_OWNER --private-key $PRIVATE_KEY --rpc-url $MAINNET_RPC --legacy
  cast send $RESERVE "transferOwnership(address)" $NEW_OWNER --private-key $PRIVATE_KEY --rpc-url $MAINNET_RPC --legacy
  ```

  After the rotation, the old key has no power at all.
* **A Gnosis Safe is not available on Mezo today.** The canonical Safe singleton and proxy factory
  have no code on chain 31612, and Mezo's own Safe-deployments fork has no 31612 entry, so the Safe
  app cannot create one here without first deploying the whole Safe stack. If an on-chain 2-of-2 is
  wanted, the realistic options are (a) a small two-of-two owner module that the engine and reserve
  can be handed to — a contained change, but it needs its own review before it holds real value — or
  (b) deploying the Safe contracts to Mezo, which is a project in itself.
* **Most of the escape routes do not need the owner at all.** Depositors leave through
  `reserve.withdraw` ✓, a position's claim is settled by its own owner through `repayReserve` ✓, and a
  position's collateral is released once the claim is gone ✓. The owner is needed only for the
  write-off path (a borrower who never repays) and for rescuing stray tokens.
* The keeper never signs anything a user would sign; it can only call `defend()` on a position inside
  its own configured band. It still should not be the deployer key.
* Set `AUTO_DEFEND=1` only after the keeper has its own key and a funded address.
* The reserve's caps are the blast radius: `maxPerPositionBps` (20% of assets), `maxLendPerCall`
  (25,000), `maxLendPerPosition` (100,000) and `utilizationCapBps` (90%) are the numbers to lower
  before anyone else's money is in the pool.
* The engine has no pause. Adding one is a new change and needs its own review; the escape routes
  above are the current answer to "get the money out", not a substitute for a pause.
