'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface SliderMark {
  value: number
  label: string
}

/**
 * Mechanical slider: a machined rail with a ruled scale, a fine snap grid, and full keyboard
 * control. Values are integers in a caller-defined unit, so quotes stay integer-exact — the slider
 * never introduces floating-point drift into a transaction amount.
 */
export function MechanicalSlider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  ariaLabel,
  marks = [],
  disabled = false,
  tone = 'amber',
  captionLeft,
  captionRight,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format: (value: number) => string
  ariaLabel: string
  marks?: SliderMark[]
  disabled?: boolean
  tone?: 'amber' | 'vermilion'
  captionLeft?: string
  captionRight?: string
}) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const fill = tone === 'vermilion' ? '#E11D48' : '#F7931A'

  const snap = useCallback(
    (raw: number) => {
      const stepped = Math.round((raw - min) / step) * step + min
      return Math.max(min, Math.min(max, stepped))
    },
    [max, min, step],
  )

  const valueFromClientX = useCallback(
    (clientX: number) => {
      const rail = railRef.current
      if (!rail) return value
      const rect = rail.getBoundingClientRect()
      const ratio = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width
      return snap(min + ratio * (max - min))
    },
    [max, min, snap, value],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent) => onChange(valueFromClientX(event.clientX))
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, onChange, valueFromClientX])

  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100
  const steps = Math.max(1, Math.round((max - min) / step))
  const unit = 1000 / steps

  const nudge = (delta: number) => {
    if (disabled) return
    onChange(snap(value + delta))
  }

  return (
    <div className={`select-none ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <span className="etched">{ariaLabel}</span>
        <span className="figure text-body text-ink">{format(value)}</span>
      </div>

      <div
        ref={railRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            nudge(-step)
          }
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            nudge(step)
          }
          if (event.key === 'PageDown') {
            event.preventDefault()
            nudge(-step * 10)
          }
          if (event.key === 'PageUp') {
            event.preventDefault()
            nudge(step * 10)
          }
          if (event.key === 'Home') {
            event.preventDefault()
            onChange(min)
          }
          if (event.key === 'End') {
            event.preventDefault()
            onChange(max)
          }
        }}
        onPointerDown={(event) => {
          if (disabled) return
          event.preventDefault()
          setDragging(true)
          onChange(valueFromClientX(event.clientX))
        }}
        className="relative h-8 cursor-ew-resize touch-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber focus-visible:outline-offset-4"
      >
        <div className="absolute inset-x-0 top-1/2 h-[6px] -translate-y-1/2 border border-rule bg-canvas shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]" />
        <div
          className="absolute top-1/2 h-[6px] -translate-y-1/2"
          style={{ left: 0, width: `${percent}%`, background: fill, opacity: 0.85 }}
        />
        {marks.map((mark) => {
          const position = max === min ? 0 : ((mark.value - min) / (max - min)) * 100
          return (
            <div
              key={mark.value}
              className="absolute top-1/2 h-[16px] w-px -translate-y-1/2 bg-rule-2"
              style={{ left: `${position}%` }}
              aria-hidden="true"
            />
          )
        })}
        <div
          className="absolute top-1/2 h-[24px] w-[3px] -translate-x-1/2 -translate-y-1/2 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
          style={{ left: `${percent}%`, background: fill }}
          aria-hidden="true"
        >
          <div className="absolute left-1/2 top-1/2 h-[8px] w-px -translate-x-1/2 -translate-y-1/2 bg-canvas/60" />
        </div>
      </div>

      {/* Ruled scale: minor ticks per snap step, major ticks every fifth, labels at named marks. */}
      <div className="relative h-6 pt-1">
        <svg viewBox="0 0 1000 10" preserveAspectRatio="none" className="h-[6px] w-full" aria-hidden="true">
          {Array.from({ length: steps + 1 }).map((_, index) => {
            const major = index % 5 === 0
            const x = index * unit
            return (
              <line
                key={index}
                x1={x}
                x2={x}
                y1={major ? 0 : 4}
                y2={10}
                stroke={major ? '#3A4149' : '#262B33'}
                strokeWidth={major ? 1.5 : 1}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
        {marks.map((mark) => {
          const position = max === min ? 0 : ((mark.value - min) / (max - min)) * 100
          return (
            <button
              key={mark.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(snap(mark.value))}
              className="absolute top-[7px] -translate-x-1/2 px-1 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-3 transition-colors hover:text-ink disabled:cursor-not-allowed"
              style={{ left: `${position}%` }}
            >
              {mark.label}
            </button>
          )
        })}
        {captionLeft ? (
          <span className="absolute bottom-0 left-0 figure text-label text-ink-3">{captionLeft}</span>
        ) : null}
        {captionRight ? (
          <span className="absolute bottom-0 right-0 figure text-label text-ink-3">{captionRight}</span>
        ) : null}
      </div>
    </div>
  )
}
