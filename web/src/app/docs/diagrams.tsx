/**
 * Two diagrams carry the whole product explanation. Both are hand-drawn SVG on the same hairline
 * grid as the terminal — no chart library, no decorative gradients, one idea each.
 */

const MONO = 'var(--font-jetbrains), ui-monospace, monospace'
const INK = '#E8EAED'
const INK2 = '#9AA1AC'
const INK3 = '#6B7280'
const RULE = '#2A2F38'
const AMBER = '#F7931A'
const VERMILION = '#E11D48'
const STEEL = '#3A4149'

/** Where a redemption lands: the queue is consumed from the 110% MCR tail upwards. */
export function RedemptionSweep() {
  const baseline = 200
  const bars = Array.from({ length: 26 }, (_, index) => {
    const depth = Math.max(0, 1 - index / 30)
    const height = 18 + depth * 118
    const x = 26 + index * 36
    const inSweep = index < 6
    const colour = inSweep ? VERMILION : index < 13 ? AMBER : STEEL
    return { x, height, colour, isYours: index === 15, sweepEdge: 246 }
  })
  const yours = bars[15]!

  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox="0 0 1000 300" className="w-full" role="img" style={{ fontFamily: MONO }}>
        <title>Redemption sweeps the queue from the lowest collateralisation ratio upwards</title>

        <text x="26" y="18" fontSize="11" fill={VERMILION} letterSpacing="1.6">
          MCR 110%
        </text>
        <text x="500" y="18" fontSize="11" fill={INK3} letterSpacing="1.6" textAnchor="middle">
          SORTEDTROVES · LOWEST ICR FIRST
        </text>
        <text x="974" y="18" fontSize="11" fill={INK3} letterSpacing="1.6" textAnchor="end">
          SAFE HEAD
        </text>

        {/* redemption sweep region */}
        <rect x="18" y="30" width="228" height={baseline - 30} fill="rgba(225,29,72,0.08)" />
        <line x1="246" y1="30" x2="246" y2={baseline} stroke={VERMILION} strokeDasharray="4 4" />

        {/* baseline and bars */}
        <line x1="18" y1={baseline} x2="982" y2={baseline} stroke={RULE} />
        <text x="18" y={baseline - 8} fontSize="10" fill={VERMILION} letterSpacing="1.2">
          110%
        </text>
        {bars.map((bar) => (
          <rect
            key={bar.x}
            x={bar.x}
            y={baseline - bar.height}
            width="10"
            height={bar.height}
            fill={bar.isYours ? INK : bar.colour}
            opacity={bar.isYours ? 1 : 0.9}
          />
        ))}

        {/* the reader's own trove */}
        <text x={yours.x + 5} y={baseline - yours.height - 28} fontSize="10" fill={INK3} textAnchor="middle">
          ICR 168%
        </text>
        <text x={yours.x + 5} y={baseline - yours.height - 14} fontSize="11" fill={INK} textAnchor="middle" letterSpacing="1.4">
          YOUR TROVE
        </text>

        {/* buffer ahead: everything a redemption consumes before it arrives here */}
        <line x1="246" y1={baseline + 16} x2={yours.x + 5} y2={baseline + 16} stroke={RULE} />
        <line x1="246" y1={baseline + 11} x2="246" y2={baseline + 21} stroke={RULE} />
        <line x1={yours.x + 5} y1={baseline + 11} x2={yours.x + 5} y2={baseline + 21} stroke={RULE} />
        <text x={(246 + yours.x + 5) / 2} y={baseline + 36} fontSize="11" fill={INK2} textAnchor="middle" letterSpacing="1.2">
          BUFFER AHEAD · 4.1M MUSD
        </text>

        {/* the sweep itself */}
        <line x1="18" y1={baseline + 46} x2="236" y2={baseline + 46} stroke={VERMILION} />
        <path d={`M236 ${baseline + 42} L246 ${baseline + 46} L236 ${baseline + 50} Z`} fill={VERMILION} />
        <text x="26" y={baseline + 64} fontSize="11" fill={VERMILION} letterSpacing="1.4">
          REDEMPTION SWEEP · 1.2M MUSD
        </text>

        <text x="500" y={baseline + 64} fontSize="10" fill={INK3} textAnchor="middle">
          Debt falls, BTC leaves the borrower, the queue advances — one trove at a time from the tail.
        </text>
      </svg>
      <figcaption className="text-[12px] leading-[1.5] text-ink-3">
        The radar on the terminal plots exactly this: rank on the horizontal axis, the BTC drawdown a trove can
        absorb on the vertical, and the shaded region is the redemption volume standing in front of a position.
      </figcaption>
    </figure>
  )
}

/** Why atomicity matters: the same unwind, with and without flash liquidity. */
export function AtomicSequence() {
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox="0 0 1000 300" className="w-full" role="img" style={{ fontFamily: MONO }}>
        <title>Unwinding a trove with and without flash liquidity</title>

        <text x="18" y="18" fontSize="11" fill={VERMILION} letterSpacing="1.6">
          WITHOUT FLASH LIQUIDITY · THREE TRANSACTIONS, CAPITAL UP FRONT
        </text>
        <line x1="18" y1="28" x2="982" y2="28" stroke={RULE} />

        {[
          { x: 18, label: 'BORROW 2,211 MUSD', detail: 'MUSD must already exist in the wallet' },
          { x: 350, label: 'REPAY TROVE', detail: 'debt falls, collateral still locked' },
          { x: 682, label: 'WITHDRAW BTC', detail: 'only then does any BTC move' },
        ].map((step, index) => (
          <g key={step.label}>
            <rect x={step.x} y="44" width="300" height="52" fill="none" stroke={RULE} />
            <text x={step.x + 12} y="66" fontSize="11" fill={INK2} letterSpacing="1.2">
              {step.label}
            </text>
            <text x={step.x + 12} y="84" fontSize="10" fill={INK3}>
              {step.detail}
            </text>
            {index < 2 ? (
              <>
                <line x1={step.x + 300} y1="70" x2={step.x + 330} y2="70" stroke={RULE} />
                <path d={`M${step.x + 330} 66 L${step.x + 340} 70 L${step.x + 330} 74 Z`} fill={RULE} />
              </>
            ) : null}
          </g>
        ))}
        <text x="18" y="118" fontSize="10" fill={VERMILION}>
          Each step can fail on its own, and the position sits half-unwound in between.
        </text>

        <text x="18" y="162" fontSize="11" fill={AMBER} letterSpacing="1.6">
          PYLON FLASH UNWIND · ONE TRANSACTION
        </text>
        <line x1="18" y1="172" x2="982" y2="172" stroke={RULE} />
        <rect x="18" y="186" width="964" height="56" fill="rgba(247,147,26,0.05)" stroke={AMBER} />

        {[
          { x: 32, label: '1 · FLASH BORROW', detail: '2,211 MUSD from Tigris' },
          { x: 272, label: '2 · WITHDRAW BTC', detail: '0.0270 BTC released' },
          { x: 512, label: '3 · SWAP', detail: '2,213 MUSD back' },
          { x: 752, label: '4 · REPAY FLASH', detail: 'principal + 0.20% fee' },
        ].map((step) => (
          <g key={step.label}>
            <text x={step.x} y="210" fontSize="11" fill={INK2} letterSpacing="1.2">
              {step.label}
            </text>
            <text x={step.x} y="228" fontSize="10" fill={INK3}>
              {step.detail}
            </text>
          </g>
        ))}

        <line x1="18" y1="258" x2="982" y2="258" stroke={STEEL} />
        <text x="18" y="276" fontSize="10" fill="#10B981">
          0.00 MUSD required in the wallet · all four legs commit or the whole transaction reverts
        </text>
        <text x="18" y="292" fontSize="10" fill={INK3}>
          Surplus BTC from the swap is swept to the owner before the transaction returns. Swaps execute at the
          Tigris pool rate, which can sit several percent either side of the Mezo oracle.
        </text>
      </svg>
      <figcaption className="text-[12px] leading-[1.5] text-ink-3">
        The same four legs build the loop (borrow → swap to BTC → adjust trove → repay) and the exit (borrow the
        debt → swap the collateral → close the trove → return the remainder).
      </figcaption>
    </figure>
  )
}
