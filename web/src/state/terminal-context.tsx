'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { RadarTrove } from '@/lib/types'

export type ArchitectMode = 'loop' | 'unwind' | 'exit' | 'shield'

interface TerminalState {
  /** Trove highlighted in the radar and loaded into the Position Architect. */
  selectedTrove: RadarTrove | null
  /** Address the architect operates on (defaults to the connected wallet). */
  targetOwner: string
  mode: ArchitectMode
  setMode: (mode: ArchitectMode) => void
  focusTrove: (row: RadarTrove, mode?: ArchitectMode) => void
  /** Paste or clear a trove address the radar does not show (native troves above the visible tail). */
  setTargetOwner: (address: string) => void
  clearSelection: () => void
}

const TerminalContext = createContext<TerminalState | null>(null)

/**
 * Shared focus between the radar and the architect: clicking a trove in the queue is the primary
 * navigation gesture of the product — it should put that trove into the execution panel, not open a
 * modal or a new page.
 */
export function TerminalProvider({
  children,
  defaultOwner = '',
}: {
  children: ReactNode
  defaultOwner?: string
}) {
  const [selectedTrove, setSelectedTrove] = useState<RadarTrove | null>(null)
  const [mode, setMode] = useState<ArchitectMode>('loop')
  const [targetOwner, setTargetOwner] = useState(defaultOwner)

  const value = useMemo<TerminalState>(
    () => ({
      selectedTrove,
      targetOwner,
      mode,
      setMode,
      focusTrove: (row, nextMode) => {
        setSelectedTrove(row)
        setTargetOwner(row.address)
        if (nextMode) setMode(nextMode)
      },
      setTargetOwner,
      clearSelection: () => setSelectedTrove(null),
    }),
    [mode, selectedTrove, targetOwner],
  )

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>
}

export function useTerminal(): TerminalState {
  const context = useContext(TerminalContext)
  if (!context) throw new Error('useTerminal must be used inside TerminalProvider')
  return context
}
