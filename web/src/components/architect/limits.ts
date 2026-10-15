/**
 * Executable bounds and venue maths for each architect mode.
 *
 * Two facts drive every bound here, and both are easy to get wrong:
 *
 *  1. Mezo's oracle price is not the price Pylon actually trades at. The Tigris MUSD/BTC pool can sit
 *     several percent away from the oracle (on Mezo Testnet it trades ~4% below it), and every loop
 *     or unwind swaps against that pool. Bounds therefore use the *venue* rate — pool reserves —
 *     whenever it is known, and fall back to the oracle only when it is not.
 *  2. The engine withdraws collateral with headroom (it withdraws ~5% more BTC than the swap needs and
 *     sweeps the surplus back to the owner), so a repayment is bounded by the collateral the trove can
 *     release, not by its ICR.
 *
 * Everything below is integer arithmetic on live values. The authoritative quote (engine API, or the
 * engine's own `preview*` views read on chain) confirms each bound before a transaction is built.
 */

export interface FeeModel {
  /** Pylon origination fee, bps. */
  pylonFeeBps: number
  /** Flash venue fee, bps. */
  flashPoolFeeBps: number
  /** Tigris swap fee, bps (one leg per operation). */
  swapFeeBps: number
  /** Safety margin added on top when deriving hard bounds, bps. */
  marginBps?: number
  /** MUSD per BTC actually achievable in the Tigris pool, WAD. Falls back to the oracle price. */
  poolRateWad?: bigint | null
  /** Engine's collateral-withdrawal headroom, bps (500 = 5%). */
  withdrawalHeadroomBps?: number
}

const WAD = 10n ** 18n

const mulDiv = (a: bigint, b: bigint, denominator: bigint): bigint =>
  denominator === 0n ? 0n : (a * b) / denominator

/** Total round-trip cost of one atomic operation, in bps. */
export const totalFeeBps = (fees: FeeModel): bigint =>
  BigInt(fees.pylonFeeBps + fees.flashPoolFeeBps + fees.swapFeeBps + (fees.marginBps ?? 5))

/** MUSD per BTC the operation will actually trade at. */
export const venueRate = (fees: FeeModel, oraclePrice: bigint): bigint => fees.poolRateWad ?? oraclePrice

/** Signed deviation of the venue rate from the oracle, in bps (negative = pool pays less for BTC). */
export const venueDeviationBps = (fees: FeeModel, oraclePrice: bigint): number | null => {
  if (!fees.poolRateWad || oraclePrice === 0n) return null
  return Number(((fees.poolRateWad - oraclePrice) * 10_000n) / oraclePrice)
}

/** Collateral value in MUSD at the venue rate. */
export const collateralValue = (coll: bigint, rate: bigint): bigint => mulDiv(coll, rate, WAD)

/**
 * Largest loop — BTC collateral added by borrowing against the same trove — that keeps the post-loop
 * ICR at or above `floorWad`.
 *
 *   post ICR = (coll + c)·rate_in / (debt + c·cost) = floor      cost = price paid per BTC acquired
 *   ⇒ collAdd = (P − floor·D) · (1−f) / (rate_buy · (floor − 1 + f))
 *
 * A trove at or below `floor` can never loop: emitting new debt strictly lowers the ratio, so this
 * returns 0 and the UI explains why instead of failing later.
 */
export const maxLoopCollAdd = (input: {
  coll: bigint
  debt: bigint
  price: bigint
  floorWad: bigint
  fees: FeeModel
}): bigint => {
  const { coll, debt, price, floorWad, fees } = input
  const rate = venueRate(fees, price)
  if (rate === 0n || coll === 0n) return 0n

  const surplus = collateralValue(coll, rate) - mulDiv(floorWad, debt, WAD)
  if (surplus <= 0n) return 0n

  const fBps = totalFeeBps(fees)
  const oneMinusF = 10_000n - fBps
  const floorGap = floorWad - WAD + mulDiv(WAD, fBps, 10_000n)
  if (floorGap <= 0n) return 0n

  // Value the surplus in BTC at the rate the loop will actually pay for it.
  const surplusBtc = mulDiv(surplus, WAD, rate)
  return mulDiv(surplusBtc * oneMinusF, WAD, 10_000n * floorGap)
}

/**
 * Largest repayment an unwind can make.
 *
 * The binding constraint is collateral: the engine releases `repay·(1+f)` of value plus its own
 * withdrawal headroom, so the ceiling is what the trove can fund at the venue rate, or what it owes,
 * shaved 1% so rounding at execution never reverts.
 */
export const maxUnwindRepay = (input: {
  coll: bigint
  debt: bigint
  price: bigint
  fees: FeeModel
}): bigint => {
  const { coll, debt, price, fees } = input
  const rate = venueRate(fees, price)
  if (rate === 0n || coll === 0n) return 0n
  const fBps = totalFeeBps(fees)
  const headroomBps = BigInt(fees.withdrawalHeadroomBps ?? 500)
  // value / ((1 + f)(1 + headroom)), kept in integers
  const fundable =
    (collateralValue(coll, rate) * 10n ** 8n) / ((10_000n + fBps) * (10_000n + headroomBps))
  const ceiling = fundable < debt ? fundable : debt
  return (ceiling * 9_900n) / 10_000n
}

/** Liquidation price implied by a trove: debt · MCR / collateral (oracle-denominated). */
export const liquidationPrice = (coll: bigint, debt: bigint, mcrWad: bigint): bigint =>
  coll === 0n ? 0n : mulDiv(debt, mcrWad, coll)

/** How far the oracle price can fall before the trove hits the MCR, in bps of the current price. */
export const distanceToLiquidationBps = (price: bigint, liqPrice: bigint): number => {
  if (price === 0n || liqPrice >= price) return 0
  return Number(((price - liqPrice) * 10_000n) / price)
}

/**
 * Mezo keeps a per-trove debt floor; a partial unwind that pushes debt below it is at best rejected
 * and at worst leaves a trove that can only be closed, so the architect caps its own ceiling at it.
 */
export const debtFloorHeadroom = (debt: bigint, minNetDebt: bigint): bigint =>
  debt > minNetDebt ? debt - minNetDebt : 0n
