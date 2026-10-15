'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** True only after the first client render — guards wallet-dependent UI against hydration drift. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return hydrated
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  return reduced
}

/**
 * Animates a figure between values (150–250ms ease-out).
 *
 * Numbers change constantly in this terminal, and a hard jump makes a table feel like it flickers.
 * Motion is the only feedback here, so it is disabled entirely under reduced-motion.
 */
export function useAnimatedValue(target: number, durationMs = 200): number {
  const reduced = usePrefersReducedMotion()
  const [value, setValue] = useState(target)
  const frame = useRef<number | null>(null)
  const from = useRef(target)
  const start = useRef(0)

  useEffect(() => {
    if (reduced || !Number.isFinite(target)) {
      setValue(target)
      return
    }
    from.current = value
    start.current = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - start.current) / durationMs)
      const eased = 1 - (1 - progress) ** 3
      setValue(from.current + (target - from.current) * eased)
      if (progress < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
    // `value` is intentionally excluded: it is the animation origin, not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, reduced])

  return value
}

export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

export type CopyState = 'idle' | 'copied' | 'failed'

export function useCopy(resetMs = 1400): { state: CopyState; copy: (value: string) => void } {
  const [state, setState] = useState<CopyState>('idle')
  const copy = useCallback(
    (value: string) => {
      const complete = () => {
        setState('copied')
        setTimeout(() => setState('idle'), resetMs)
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value).then(complete, () => setState('failed'))
        return
      }
      setState('failed')
    },
    [resetMs],
  )
  return { state, copy }
}

/** UTC clock used by the instrument bar; ticks once per second without re-rendering the page. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
