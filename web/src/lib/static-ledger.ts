import { explorerTx } from './chain'
import type { Proof } from './types'

/**
 * Frozen ledger shipped with the bundle.
 *
 * These are the real Mezo Testnet transactions from `contracts/broadcast/Deploy.s.sol/31611`, so the
 * proof panel still shows verifiable history when the engine API is offline. Nothing here is
 * simulated: every row links to an explorer transaction for chain 31611. Rows whose receipts are not
 * served by the public RPC (pruned historical receipts) carry `block: null` rather than a guess.
 */
const row = (
  id: string,
  txHash: string,
  kind: Proof['kind'],
  note: string,
  actor: string,
  block: number | null = null,
): Proof => ({
  id,
  kind,
  txHash,
  explorerUrl: explorerTx(txHash),
  actor,
  note,
  musd: null,
  btc: null,
  feeMusd: null,
  block,
  timestamp: null,
})

export const STATIC_LEDGER: Proof[] = [
  row(
    'flash-loop',
    '0x7933c8531f1c368da18ec70496e3d5eb5d6167f2b0160a63db224d21751e6430',
    'loop',
    'Flash loop on a native Mezo trove: 394.77 MUSD flashed from the MUSD/mUSDC pool, swapped to 0.005 BTC on the MUSD/BTC pool, posted as collateral with one EIP-712 signature, then repaid with the trove borrow. 0.79 MUSD origination fee routed to the shield pool.',
    '0x3bEe06fA351E66e298eF4DDcbE6052770775a93e',
    16176373,
  ),
  row(
    'flash-unwind',
    '0xe7e020535e7888a5d34a51eedacac0f79d2e84ef100c728e33817fb39b32b7e2',
    'unwind',
    'Flash unwind with zero MUSD in the wallet: 300 MUSD of debt repaid out of the trove own collateral, 0.00401 BTC released, just enough sold to repay the flash plus fees. Wallet held 0 MUSD before the transaction and gained the surplus afterwards.',
    '0x3bEe06fA351E66e298eF4DDcbE6052770775a93e',
    16176420,
  ),
  row(
    'flash-exit',
    '0xfd3e382ffa9b180939f52dfd8214f75ef6e1bc9f28bd42de500d572e7de48311',
    'exit',
    'Flash exit: the trove was closed with one signature, a slice of the released collateral repaid the flash, and 0.0218 BTC came back to the wallet without any up-front MUSD.',
    '0x3bEe06fA351E66e298eF4DDcbE6052770775a93e',
    16176450,
  ),
  row(
    'position-created',
    '0x229c77a7d9572b52d20e4b07faca892ef2fa3852def1c8556036f4b8c432e9ea',
    'reserve',
    'Pylon position created and registered with the shield reserve.',
    '0x4B965638eE7e42587019774fF50407204F83990d',
    16176989,
  ),
  row(
    'shield-defence',
    '0x0e3b671079592808ca499c830367a4f7deb012ae2c0f7bd9b6e9cdda2a2fb511',
    'shield',
    'Permissionless shield defence called by a third party (not the position owner): the reserve lent 543.94 MUSD, the position repaid its own debt, and its ICR went from 142% to 180%. The reserve claim is booked on-chain and blocks any collateral withdrawal until it is settled.',
    '0x3bEe06fA351E66e298eF4DDcbE6052770775a93e',
    16177307,
  ),
  row(
    'reserve-deposit',
    '0x9321dd9e394cf0166fd9cf0fcd78d49b31b142bf1c05bad47e190ef052600b68',
    'reserve',
    'Shield pool seeded with 1,000 MUSD. It has since earned flash origination fees; the share price prints above 1.0 in the reserve panel.',
    '0x3bEe06fA351E66e298eF4DDcbE6052770775a93e',
    16176318,
  ),
  row(
    'native-trove-open',
    '0xe10f306cc3d04df73f9945301bd16b68d7c273413f2a99e9ab0ba355bc0792ae',
    'loop',
    'Native Mezo trove opened: 0.045 BTC collateral against 1,800 MUSD of debt (185% ICR) — the position every flash operation above was executed against.',
    '0x3bEe06fA351E66e298eF4DDcbE6052770775a93e',
    16176114,
  ),
  row(
    'engine-deploy',
    '0x479c2d1e983ba8e4f522e1d378295fc928920497e6889df438c018d63a381984',
    'deploy',
    'PylonFlashEngine v2 deployed, replacing v1 after live execution showed v1 parked repayment MUSD at the wrong caller.',
    '0x0bafCB6C0F10b5F6a5e1C9f7514cB736699c9CF9',
    16176390,
  ),
]
