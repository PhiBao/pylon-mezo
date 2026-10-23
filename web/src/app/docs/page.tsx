'use client'

import { AddressChip } from '@/components/ui/AddressChip'
import { Meter } from '@/components/ui/Meter'
import { SpecRow } from '@/components/ui/Panel'
import { API_BASE } from '@/lib/api'
import {DEPLOYED, NETWORK_LABEL } from '@/lib/chain'
import { fmtBps, fmtMusd, fmtUnits, fmtWadPct } from '@/lib/format'
import { useMarket, useReserve, useRuntimeConfig } from '@/state/queries'
import { AtomicSequence, RedemptionSweep } from './diagrams'

export default function DocsPage() {
  const config = useRuntimeConfig().data?.value
  const market = useMarket().data?.value
  const reserve = useReserve().data?.value

  return (
    <div className="mx-auto max-w-[1560px] border-x border-rule">
      <header className="flex flex-col gap-3 border-b border-rule px-4 py-6">
        <span className="etched">Documentation</span>
        <h1 className="max-w-[40ch] text-h1 text-ink">Pylon is an execution and risk terminal for Mezo borrowers.</h1>
        <p className="max-w-[84ch] text-lede text-ink-2">
          Mezo is a bitcoin-backed CDP: deposit BTC, borrow the MUSD stablecoin. Two properties of the protocol
          shape everything a borrower can do — debt can only be adjusted by signing with the trove owner&apos;s key,
          and any MUSD holder can redeem against the cheapest-to-redeem trove. Pylon turns both facts into usable
          operations.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 border-b border-rule xl:border-b-0 xl:border-r">
          <Section anchor="market" title="1 · The market it serves">
            <p>
              Pylon is a primitive for the <strong>MUSD economy</strong>, not a single pair. Mezo mainnet
              lists <strong>33 MUSD pairs</strong> — Bitcoin, mUSDC, mUSDT, WUSD, sUSDat, mSolvBTC, and the
              tokenised-equity pairs (MSTR, COIN, TSLA, NVDA, GOOGL, CRCL, BTDR) that make Mezo different.
              Every one of them has the same problem: a borrowed position is static, and the redemption
              queue does not care how healthy the system looks on average.
            </p>
            <p>
              The numbers that matter are the ratio between redemption pressure and the borrower base.
              At the time of writing the queue carries <strong>≈429M MUSD</strong> of depth against
              <strong> 294 troves</strong> on testnet and a mainnet borrower base that is still counted in
              single digits. The shield is priced against that gap: the queue is deep, the tooling to get
              out of its way is thin.
            </p>
            <p>
              The engine takes its flash and swap venues as constructor arguments, so serving a new MUSD
              pair is a deployment, not a rewrite. That is the expansion path: start with BTC, then the
              equity pairs whose holders have the same redemption risk and no equivalent tool.
            </p>
          </Section>

          <Section anchor="redemption" title="2 · The mechanic that makes this necessary">
            <p>
              Mezo&apos;s redemption works like Liquity&apos;s: a holder of MUSD can always exchange it for $1 of BTC
              from the protocol, taken from the trove with the lowest collateralisation ratio that is still above the
              110% minimum (MCR). The protocol keeps that order in a contract called{' '}
              <span className="figure text-ink">SortedTroves</span>, which is the single most important object for a
              borrower to understand.
            </p>
            <RedemptionSweep />
            <p>
              A redemption repays the tail trove&apos;s debt and takes an equal value of its BTC. The borrower&apos;s
              debt falls, their collateral falls, and their ICR moves up slightly — but they have lost exposure to
              BTC without choosing to. For a position at 111%, a routine redemption is an involuntary sale.
            </p>
            <p>
              The number that matters is therefore not &ldquo;am I healthy?&rdquo; but{' '}
              <span className="text-ink">how much redemption volume stands in front of me</span>. Pylon calls that the
              buffer ahead, and prints it for every trove in the queue, next to the walk that is currently consuming
              it.
            </p>
            <div className="my-4 border border-rule">
              <SpecRow label="Minimum collateral ratio (MCR)" value={config ? fmtWadPct(config.mcrWad) : '110%'} hint="below it, a trove is liquidatable" />
              <SpecRow label="Recovery-mode threshold (CCR)" value={config ? fmtWadPct(config.ccrWad) : '150%'} hint="borrowing is restricted below it" />
              <SpecRow label="Gas compensation per trove" value={config ? fmtMusd(config.gasCompensation, { fixed: 0 }) : '200 MUSD'} tone="muted" />
              <SpecRow label="Minimum net debt" value={config ? fmtMusd(config.minNetDebt, { fixed: 0 }) : '1,800 MUSD'} tone="muted" />
            </div>
          </Section>

          <Section anchor="operations" title="3 · Three operations, one mechanism">
            <p>
              Each operation borrows MUSD from a Tigris flash pool, uses it for one leg, and settles the loan before
              the transaction returns. Nothing needs to be sitting in the wallet, and a failure at any leg reverts the
              whole thing.
            </p>
            <AtomicSequence />
            <div className="grid gap-4 pt-2 md:grid-cols-3">
              <Card title="Flash Loop">
                Borrow against the trove, buy BTC with the proceeds, post it back as collateral. The position gets
                larger and the ICR is unchanged apart from fees. Blocked below the 150% CCR, because emitting new debt
                there is what pushes a trove into recovery mode.
                <span className="figure mt-2 block text-[11px] text-ink-3">entry point: loopSigned(LoopRequest)</span>
              </Card>
              <Card title="Flash Unwind">
                Repay debt out of the trove&apos;s own collateral with zero MUSD in the wallet: the venue fronts the
                MUSD, the released BTC buys it back, the surplus stays with the borrower. Above 100.3% ICR the ratio
                improves with every unit repaid.
                <span className="figure mt-2 block text-[11px] text-ink-3">entry point: unwindSigned(UnwindRequest)</span>
              </Card>
              <Card title="Flash Exit">
                Close the trove entirely. The venue flashes the outstanding debt less Mezo&apos;s gas compensation, the
                collateral buys that MUSD back, the trove closes, and the remaining BTC plus the released compensation
                are swept to the wallet.
                <span className="figure mt-2 block text-[11px] text-ink-3">entry point: closeSigned(CloseRequest)</span>
              </Card>
            </div>
          </Section>

          <Section anchor="shield" title="4 · The redemption shield">
            <p>
              Operations are reactive: they fix a position after the fact. The shield is the proactive half. A Pylon
              position stores a policy — an ICR trigger, an ICR target and a per-call ceiling — and a MUSD reserve
              stands behind it. When the position&apos;s ICR enters the band, <span className="text-ink">anyone</span>{' '}
              can call <span className="figure text-ink">defend()</span>; the reserve lends MUSD, and the position spends
              it on repaying its own debt until the target is reached.
            </p>
            <ul className="flex flex-col gap-2">
              <li>
                The reserve can only ever call <span className="figure text-ink">lendTo(position)</span>, and the
                position can only spend it on <span className="figure text-ink">repayMUSD</span> for its own trove.
              </li>
              <li>
                A loan blocks <span className="figure text-ink">withdrawCollateral</span> and{' '}
                <span className="figure text-ink">executeClose</span> until it is settled, so the claim is enforced in
                code, not by trust.
              </li>
              <li>
                Defence must improve the ratio or it reverts — a defence call cannot make a position worse.
              </li>
              <li>
                Reserve lenders receive non-transferable shares priced at total assets over total shares. Flash fees
                accrue to the pool; defence loans are the risk.
              </li>
            </ul>
            <div className="mt-4 border border-rule">
              <SpecRow label="Reserve total assets" value={reserve ? fmtMusd(reserve.totalAssets) : '—'} />
              <SpecRow label="Share price" value={reserve ? fmtUnits(reserve.sharePrice, 18, { fixed: 4 }) : '—'} tone="emerald" />
              <SpecRow
                label="Utilisation"
                value={reserve ? `${fmtBps(reserve.utilizationBps)} of ${fmtBps(reserve.utilizationCapBps)} cap` : '—'}
                tone="muted"
              />
              <SpecRow label="Lending only to" value="registered Pylon positions" tone="muted" />
            </div>
            {reserve ? (
              <div className="mt-3">
                <Meter valueBps={reserve.utilizationBps} capBps={reserve.utilizationCapBps} />
              </div>
            ) : null}
          </Section>

          <Section anchor="fees" title="5 · What an operation costs">
            <p>
              Fees are charged on the flashed notional, not on the borrowed balance, so a loop on a trove with no
              MUSD in the wallet costs a fraction of a percent of the amount it moves.
            </p>
            <div className="border border-rule">
              <SpecRow
                label="Pylon origination fee"
                value={market ? fmtBps(market.flashFeeBps) : '0.20%'}
                hint="on the flashed amount"
                tone="amber"
              />
              <SpecRow
                label="Flash venue fee"
                value={config ? fmtBps(config.flashPoolFeeBps) : '0.01%'}
                hint="charged by the Tigris pool"
              />
              <SpecRow
                label="Swap fee"
                value={market ? fmtBps(market.swapFeeBps) : '0.04%'}
                hint="one leg per operation"
              />
              <SpecRow label="Mezo borrowing fee" value="0.10%" hint="on debt increases only" />
              <SpecRow label="Mezo fixed interest" value="1.00%" hint="accrues on the principal, set at open" tone="muted" />
              <SpecRow label="BTC gas" value={`native BTC on ${NETWORK_LABEL}`} tone="muted" />
            </div>
            <p className="pt-3">
              A flash unwind on a 2,211 MUSD debt therefore costs roughly 5–6 MUSD in combined fees, of which nothing
              has to be held in advance. The X-ray in the Position Architect prints the exact figure for any size
              before anything is signed.
            </p>
          </Section>

          <Section anchor="security" title="6 · Security model">
            <ul className="flex flex-col gap-2">
              <li>
                <span className="text-ink">No custody, no rehypothecation.</span> Pylon never holds collateral or MUSD
                between transactions, and it has no allowance over any asset.
              </li>
              <li>
                <span className="text-ink">Signature-bound authorisation.</span> Trove changes are authorised with an
                EIP-712 struct (<span className="figure text-ink">AdjustTrove</span> /{' '}
                <span className="figure text-ink">CloseTrove</span>) verified by Mezo&apos;s own{' '}
                <span className="figure text-ink">BorrowerOperationsSignatures</span> contract. It is bound to the
                owner, the recipient, a nonce and a deadline, so a signature cannot be replayed or retargeted.
              </li>
              <li>
                <span className="text-ink">Two broadcast routes, one rule.</span> The engine service may relay a
                transaction, but it can only relay what the signature already authorises. Self-broadcast uses the same
                struct, sent directly from the wallet.
              </li>
              <li>
                <span className="text-ink">Target allowlist.</span> Before a wallet transaction is sent the terminal
                checks the destination against the deployed Pylon and Mezo addresses, and refuses anything else.
              </li>
              <li>
                <span className="text-ink">Slippage and health floors.</span> Every operation carries a minimum
                post-operation ICR, and the swap legs carry a minimum output. Both are visible in the X-ray before
                signing.
              </li>
              <li>
                <span className="text-ink">Revert, do not half-finish.</span> Flash liquidity and health checks happen
                inside the same transaction, so a failed operation costs gas rather than leaving a position in an
                intermediate state.
              </li>
              <li>
                <span className="text-ink">Trust surface to acknowledge.</span> The terminal reads state through the
                public Mezo RPC and the engine service. If both lied, the numbers shown would be wrong — the
                explorer-linked proof ledger exists so any row can be checked independently.
              </li>
            </ul>
          </Section>

          <Section anchor="api" title="7 · API surface">
            <p>
              The terminal is a static bundle: it talks to the engine service at{' '}
              <span className="figure text-ink">{API_BASE}</span> and falls back to direct chain reads when that
              service is unreachable.
            </p>
            <div className="overflow-x-auto border border-rule">
              <table className="ledger">
                <thead>
                  <tr>
                    <th className="cell-l w-[86px]">Method</th>
                    <th className="cell-l">Path</th>
                    <th className="cell-l">Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['GET', '/api/v1/config', 'Deployed addresses, fee parameters, MCR/CCR, minimum net debt'],
                    ['GET', '/api/v1/market', 'BTC price, pool reserves, TCR, recovery mode, trove count'],
                    ['GET', '/api/v1/radar?limit=', 'The redemption queue: distribution, tail and head rows'],
                    ['GET', '/api/v1/trove/:address', 'One trove: collateral, debt, ICR, rank, buffer ahead, hints'],
                    ['GET', '/api/v1/quote/loop', 'Size a loop for a collateral addition: debt delta, fees, post ICR'],
                    ['GET', '/api/v1/quote/unwind', 'Size an unwind: MUSD needed, BTC in, post ICR'],
                    ['GET', '/api/v1/quote/exit', 'Size an exit: flash amount, BTC in, BTC returned'],
                    ['GET', '/api/v1/reserve', 'Shield pool: assets, shares, utilisation, loans'],
                    ['GET', '/api/v1/proofs', 'Explorer-linked execution ledger'],
                    ['GET', '/api/v1/position/:address', 'Shield policy, reserve loan and health for one position'],
                    ['GET', '/api/v1/hints', 'SortedTroves insert position for a post-operation nominal CR'],
                    ['POST', '/api/v1/build/loop', 'EIP-712 typed data + calldata for a loop'],
                    ['POST', '/api/v1/execute/loop', 'Relay a signed loop and return the transaction hash'],
                    ['GET', '/api/v1/x402/trove-report/:address', 'x402-gated trove report: queue rank, buffer ahead, health band, liquidation price'],
                  ].map(([method, path, purpose]) => (
                    <tr key={path}>
                      <td className="cell-l text-amber">{method}</td>
                      <td className="cell-l text-ink">{path}</td>
                      <td className="cell-l text-ink-2">{purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section anchor="agents" title="7 · Agents and the paid report">
        <p>
          A keeper that wants to defend a trove needs one fact before it spends anything: where that trove sits in
          the redemption queue. The engine sells exactly that as an x402 resource —{' '}
          <span className="figure text-ink">GET /api/v1/x402/trove-report/:address</span> — priced in MUSD on Mezo.
        </p>
        <ul className="flex flex-col gap-2">
          <li>
            <span className="text-ink">Challenge.</span> An unpaid request returns HTTP 402 with an{' '}
            <span className="figure text-ink">accepts[]</span> entry (scheme <span className="figure text-ink">exact</span>,
            network <span className="figure text-ink">eip155:31611</span>, asset MUSD, a pay-to address and a price),
            plus the same payload base64-encoded in the <span className="figure text-ink">PAYMENT-REQUIRED</span> header.
          </li>
          <li>
            <span className="text-ink">Settlement, trustlessly.</span> The terminal sends a real MUSD transfer from
            the wallet and retries with <span className="figure text-ink">X-PAYMENT-TX: &lt;hash&gt;</span>; the service
            verifies the transfer against Mezo before answering. No facilitator, no custody.
          </li>
          <li>
            <span className="text-ink">Settlement, signed.</span> Alternatively the payer signs an EIP-3009{' '}
            <span className="figure text-ink">transferWithAuthorization</span> and the engine&apos;s facilitator redeems
            it. Both routes are implemented; the on-chain transfer works on any deployment.
          </li>
          <li>
            <span className="text-ink">The resource.</span> A JSON report: queue rank, MUSD buffer ahead, health band,
            collateral value, debt, liquidation price and the block the telemetry was computed at.
          </li>
        </ul>
      </Section>

      <Section anchor="limits" title="8 · Limits and roadmap">
            <ul className="flex flex-col gap-2">
              <li>
                Shielding a <span className="text-ink">native</span> Mezo trove needs that trove to be operated by a
                Pylon position; today the terminal offers to create one and open its trove, and documents the
                migration instead of faking it.
              </li>
              <li>
                Unwind and exit accept an approximate collateral ceiling, refined by the engine&apos;s previews at
                quote time; the swap &ldquo;exact out&rdquo; leg is what pins the final numbers.
              </li>
              <li>
                The engine API is optional. Without it the terminal runs read-only against RPC for everything except
                quote sizing, which then uses the engine&apos;s own on-chain preview functions.
              </li>
              <li>
                Next: multi-trove portfolios with a combined health view, scheduled shield defences, a keeper
                incentive funded by the reserve, and cross-trove unwinds that move debt to the healthiest position
                first.
              </li>
            </ul>
          </Section>

          <Section anchor="reproduce" title="9 · Reproduce it" last>
            <pre className="overflow-x-auto border border-rule bg-canvas p-3 font-mono text-[12px] leading-[1.6] text-ink-2">
{`git clone <repo> && cd web
pnpm install
pnpm typecheck       # strict TS, no implicit any, no unchecked index access
pnpm build           # static export → ./out
pnpm preview         # serve the exported bundle

# optional: point the terminal at a running engine service
NEXT_PUBLIC_API_BASE=http://localhost:8787 pnpm dev`}
            </pre>
            <p className="pt-3">
              Every contract address used by the terminal is listed on the{' '}
              <a className="link" href="/proofs/">
                proofs page
              </a>{' '}
              and on chain: engine{' '}
              <span className="figure text-ink">{DEPLOYED.engine}</span>, reserve{' '}
              <span className="figure text-ink">{DEPLOYED.reserve}</span>.
            </p>
            <div className="flex flex-wrap gap-3 pt-3">
              <AddressChip address={DEPLOYED.engine} label="Engine" />
              <AddressChip address={DEPLOYED.reserve} label="Reserve" />
              <AddressChip address={DEPLOYED.sortedTroves} label="SortedTroves" />
            </div>
          </Section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 px-4 py-6">
          <span className="etched">On this page</span>
          <nav className="flex flex-col gap-2">
            {[
              ['#redemption', 'The mechanic'],
              ['#operations', 'Three operations'],
              ['#shield', 'Redemption shield'],
              ['#fees', 'What it costs'],
              ['#security', 'Security model'],
              ['#api', 'API surface'],
              ['#agents', 'Agents and x402'],
              ['#limits', 'Limits and roadmap'],
              ['#reproduce', 'Reproduce it'],
            ].map(([href, label]) => (
              <a key={href} href={href} className="link figure text-meta">
                {label}
              </a>
            ))}
          </nav>

          <div className="mt-2 border border-rule px-3 py-3">
            <span className="etched">Live protocol state</span>
            <div className="pt-2">
              <SpecRow label="BTC / USD" value={market ? `$${fmtUnits(market.btcPriceWad, 18, { fixed: 2 })}` : '—'} tone="amber" />
              <SpecRow label="System ICR" value={market ? fmtWadPct(market.tcrWad) : '—'} />
              <SpecRow label="Troves" value={market ? String(market.troveCount) : '—'} tone="muted" />
              <SpecRow label="Recovery mode" value={market?.recoveryMode ? 'active' : 'no'} tone={market?.recoveryMode ? 'vermilion' : 'emerald'} />
            </div>
          </div>

          <div className="border border-rule px-3 py-3">
            <span className="etched">Instrument notes</span>
            <ul className="flex flex-col gap-1.5 pt-2 text-[12px] leading-[1.5] text-ink-3">
              <li>18-decimal integers everywhere; nothing is rendered in wei.</li>
              <li>Log scale on every ICR axis — the real range spans 110% to four figures.</li>
              <li>Motion is limited to number changes and one pulse on your own trove.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Section({
  anchor,
  title,
  children,
  last = false,
}: {
  anchor: string
  title: string
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <section id={anchor} className={`scroll-mt-20 px-4 py-6 ${last ? '' : 'border-b border-rule'}`}>
      <h2 className="pb-3 font-display text-h2 text-ink">{title}</h2>
      <div className="flex max-w-[92ch] flex-col gap-3 text-body text-ink-2">{children}</div>
    </section>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col border border-rule px-3 py-3">
      <span className="etched pb-2">{title}</span>
      <p className="text-body text-ink-2">{children}</p>
    </div>
  )
}
