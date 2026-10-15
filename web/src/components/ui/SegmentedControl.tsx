'use client'

import { useRef } from 'react'

export interface Segment<T extends string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

/**
 * Four-position mechanical switch: one declared width per segment, hairline dividers, and the
 * active position marked by a milled bottom edge rather than a colour fill.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  size = 'md',
}: {
  segments: Array<Segment<T>>
  value: T
  onChange: (value: T) => void
  label: string
  size?: 'md' | 'sm'
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const move = (delta: number) => {
    const index = segments.findIndex((segment) => segment.value === value)
    let next = index
    for (let step = 0; step < segments.length; step += 1) {
      next = (next + delta + segments.length) % segments.length
      const candidate = segments[next]
      if (candidate && !candidate.disabled) {
        onChange(candidate.value)
        refs.current[next]?.focus()
        return
      }
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-full border border-rule bg-panel"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {segments.map((segment, index) => {
        const active = segment.value === value
        return (
          <button
            key={segment.value}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={segment.disabled}
            tabIndex={active ? 0 : -1}
            title={segment.hint}
            onClick={() => onChange(segment.value)}
            className={`relative flex flex-1 items-center justify-center border-l border-rule px-2 first:border-l-0 ${
              size === 'sm' ? 'h-7' : 'h-9'
            } font-mono text-label uppercase tracking-[0.14em] transition-colors ${
              segment.disabled
                ? 'cursor-not-allowed text-ink-3/60'
                : active
                  ? 'bg-raised text-ink'
                  : 'text-ink-3 hover:bg-raised/60 hover:text-ink-2'
            }`}
          >
            {segment.label}
            {active ? <span className="absolute inset-x-0 bottom-0 h-[2px] bg-amber" /> : null}
          </button>
        )
      })}
    </div>
  )
}
