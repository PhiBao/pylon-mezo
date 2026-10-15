import { parseAbi } from 'viem'

/**
 * Only the surface the terminal actually touches, written as human-readable ABIs so the wire shape
 * is auditable against contracts/src/interfaces/*.sol.
 */

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

export const oracleAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])

export const troveManagerAbi = parseAbi([
  'function getTroveStatus(address borrower) view returns (uint8)',
  'function getTroveColl(address borrower) view returns (uint256)',
  'function getTroveDebt(address borrower) view returns (uint256)',
  'function getTrovePrincipal(address borrower) view returns (uint256)',
  'function getTroveInterestOwed(address borrower) view returns (uint256)',
  'function getTroveInterestRate(address borrower) view returns (uint16)',
  'function getCurrentICR(address borrower, uint256 price) view returns (uint256)',
  'function getNominalICR(address borrower) view returns (uint256)',
  'function getEntireDebtAndColl(address borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getTCR(uint256 price) view returns (uint256)',
  'function checkRecoveryMode(uint256 price) view returns (bool)',
  'function MCR() view returns (uint256)',
  'function CCR() view returns (uint256)',
])

export const sortedTrovesAbi = parseAbi([
  'function contains(address id) view returns (bool)',
  'function getSize() view returns (uint256)',
  'function getFirst() view returns (address)',
  'function getLast() view returns (address)',
  'function getNext(address id) view returns (address)',
  'function getPrev(address id) view returns (address)',
  'function findInsertPosition(uint256 nicr, address prevId, address nextId) view returns (address, address)',
])

export const hintHelpersAbi = parseAbi([
  'function getApproxHint(uint256 cr, uint256 numTrials, uint256 inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)',
])

export const borrowerOpsAbi = parseAbi([
  'function getBorrowingFee(uint256 debt) view returns (uint256)',
  'function minNetDebt() view returns (uint256)',
  'function MUSD_GAS_COMPENSATION() view returns (uint256)',
])

export const borrowerOpsSignaturesAbi = parseAbi([
  'function getNonce(address user) view returns (uint256)',
])

export const tigrisPoolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint32 blockTimestampLast)',
])

export const poolFactoryAbi = parseAbi([
  'function getFee(address pool, bool stable) view returns (uint256)',
])

/**
 * PylonFlashEngine — read side plus the three signature-authorised entry points the terminal can
 * self-broadcast from a connected wallet (backend-relayed broadcast uses the same calldata).
 */
export const pylonEngineAbi = parseAbi([
  // configuration / view surface
  'function musd() view returns (address)',
  'function btc() view returns (address)',
  'function reserve() view returns (address)',
  'function borrowerOps() view returns (address)',
  'function borrowerOpsSignatures() view returns (address)',
  'function troveManager() view returns (address)',
  'function sortedTroves() view returns (address)',
  'function hintHelpers() view returns (address)',
  'function flashFeeBps() view returns (uint16)',
  'function swapPoolFeeBps() view returns (uint256)',
  'function flashPoolFeeBps() view returns (uint256)',
  'function gasCompensation() view returns (uint256)',
  'function minNetDebt() view returns (uint256)',
  'function isPosition(address account) view returns (bool)',
  'function musdIsToken0() view returns (bool)',
  'function flashMusdIsToken0() view returns (bool)',
  'function feeReport(uint256 amount) view returns (uint256)',
  'function flashPoolState() view returns (uint256 musdReserve, uint256 otherReserve, uint256 feeBps)',
  'function swapPoolState() view returns (uint256 musdReserve, uint256 btcReserve, uint256 feeBps)',
  // previews — the authoritative local quote maths, mirrored byte-for-byte in the engine API
  'function previewLoopDebtForCollateral(uint256 collAdd) view returns (uint256 debtDelta, uint256 pylonFee)',
  'function previewLoopCollateralForDebt(uint256 debtDelta) view returns (uint256 collAdd, uint256 pylonFee)',
  'function previewUnwindMusdNeeded(uint256 repayAmount) view returns (uint256)',
  'function previewUnwindBtcIn(uint256 repayAmount) view returns (uint256)',
  'function previewClose(address owner) view returns (uint256 btcIn, uint256 debt)',
  'function previewBtcOut(uint256 musdIn) view returns (uint256)',
  'function previewMusdIn(uint256 btcOut) view returns (uint256)',
  // execution
  'function createPosition(address owner) returns (address position)',
  'function loopSigned((address owner, uint256 debtAmount, uint256 collAdd, address outputTo, uint256 minPostICR, uint256 deadline, address upperHint, address lowerHint, bytes signature) r) returns (uint256 btcOut, uint256 feeMusd)',
  'function unwindSigned((address owner, uint256 repayAmount, uint256 collOut, address outputTo, uint256 minPostICR, uint256 deadline, address upperHint, address lowerHint, bytes signature) r) returns (uint256 musdOut, uint256 btcToOwner)',
  'function closeSigned((address owner, address outputTo, uint256 deadline, bytes signature) r) returns (uint256 btcToOwner, uint256 feeMusd)',
  // events used by the proof ledger when reading straight from logs
  'event Looped(address indexed owner, uint256 musdBorrowed, uint256 btcAdded, uint256 feeMusd)',
  'event Unwound(address indexed owner, uint256 musdRepaid, uint256 btcWithdrawn, uint256 btcSwapped, uint256 feeMusd)',
  'event Exited(address indexed owner, uint256 musdRepaid, uint256 btcReturned, uint256 feeMusd)',
])

/** PylonPosition — one contract per shielded trove (EIP-1167 clone of the implementation). */
export const pylonPositionAbi = parseAbi([
  'function owner() view returns (address)',
  'function engine() view returns (address)',
  'function executor() view returns (address)',
  'function reserveDebt() view returns (uint256)',
  'function policy() view returns (bool enabled, uint64 triggerICR, uint64 targetICR, uint128 maxPerCall)',
  'function isActive() view returns (bool)',
  'function health() view returns (uint256 coll, uint256 debt, uint256 icr, uint256 price)',
  'function openTrove(uint256 debtAmount) payable',
  'function setShield(bool enabled, uint64 triggerICR, uint64 targetICR, uint128 maxPerCall)',
  'function defend() returns (uint256 repaid)',
  'function repayReserve(uint256 amount)',
  'function setExecutor(address executor)',
])

/** PylonReserve — MUSD-denominated shield pool. Shares are non-transferable. */
export const pylonReserveAbi = parseAbi([
  'function musd() view returns (address)',
  'function engine() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function shares(address account) view returns (uint256)',
  'function idleLiquidity() view returns (uint256)',
  'function outstanding() view returns (uint256)',
  'function feesReceived() view returns (uint256)',
  'function maxLendPerCall() view returns (uint256)',
  'function maxLendPerPosition() view returns (uint256)',
  'function utilizationCapBps() view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function convertToAssets(uint256 shareBalance) view returns (uint256)',
  'function availableToLend(address position) view returns (uint256)',
  'function loans(address position) view returns (uint256)',
  'function positions(address position) view returns (bool)',
  'function deposit(uint256 assets, address receiver) returns (uint256 sharesMinted)',
  'function withdraw(uint256 shareAmount, address receiver, address shareOwner) returns (uint256 assets)',
  'event Deposited(address indexed depositor, address indexed receiver, uint256 assets, uint256 sharesMinted)',
  'event Lent(address indexed position, uint256 amount, uint256 totalOutstanding)',
])
