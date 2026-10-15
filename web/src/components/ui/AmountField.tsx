'use client'

import { useId } from 'react'
import { fmtUnits } from '@/lib/format'

/** Decimal input for an 18-decimal asset: unit is part of the field, MAX is one click away. */
export function AmountField({
  label,
  value,
  onChange,
  unit,
  placeholder = '0.00',
  balanceWei,
  onMax,
  error,
  hint,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  unit: string
  placeholder?: string
  balanceWei?: string | null
  onMax?: () => void
  error?: string | null
  hint?: string
  disabled?: boolean
}) {
  const id = useId()

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="etched" htmlFor={id}>
          {label}
        </label>
        {balanceWei !== undefined && balanceWei !== null ? (
          <button
            type="button"
            className="figure text-label text-ink-3 transition-colors hover:text-ink"
            onClick={onMax}
            disabled={disabled || !onMax}
            title="Use full balance"
          >
            BAL {fmtUnits(balanceWei, 18, { small: 4, normal: 4, min: 2 })} {unit} · MAX
          </button>
        ) : hint ? (
          <span className="figure text-label text-ink-3">{hint}</span>
        ) : null}
      </div>

      <div className="relative">
        <input
          id={id}
          className="field pr-16"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-label uppercase tracking-[0.14em] text-ink-3">
          {unit}
        </span>
      </div>

      {error ? (
        <span id={`${id}-error`} className="figure text-label text-vermilion">
          {error}
        </span>
      ) : hint && balanceWei !== undefined ? (
        <span className="figure text-label text-ink-3">{hint}</span>
      ) : null}
    </div>
  )
}
