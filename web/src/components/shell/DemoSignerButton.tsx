'use client'

import { useEffect, useRef, useState } from 'react'
import { shortAddress } from '@/lib/format'
import { connectDemoKey, disconnectDemoKey, useDemoSigner } from '@/state/demo-signer'

/**
 * Header control for the demo signer. Two states:
 *   · no key — a quiet "Demo key" button that opens the paste dialog;
 *   · a key — a DEMO chip with the address, and a dialog offering to forget it.
 *
 * The dialog never stores the key; see src/state/demo-signer.ts.
 */
export function DemoSignerButton() {
  const demo = useDemoSigner()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const container = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const submit = () => {
    if (connectDemoKey(value)) {
      setValue('')
      setError(null)
      setOpen(false)
    } else {
      setError('That is not a readable private key.')
    }
  }

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        className={`btn ${demo.address ? 'border-amber/60 text-amber' : 'btn-quiet'}`}
        onClick={() => setOpen((value) => !value)}
        title={
          demo.address
            ? 'Signing locally with a demo key — no wallet extension'
            : 'Paste a private key to sign without a wallet extension'
        }
      >
        {demo.address ? (
          <>
            <span className="inline-block h-[5px] w-[5px] bg-amber" />
            Demo {shortAddress(demo.address, 4)}
          </>
        ) : (
          'Demo key'
        )}
      </button>

      {open ? (
        <div className="plate-raised absolute right-0 top-[46px] z-30 w-[340px] p-3">
          <span className="etched">Demo signer</span>
          {demo.address ? (
            <div className="flex flex-col gap-3 pt-3">
              <p className="text-body text-ink-2">
                Signing as <span className="figure text-ink">{demo.address}</span>. The key lives in this
                tab&apos;s memory only, and every action it authorises is the same EIP-712 ballot a wallet
                would sign.
              </p>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  disconnectDemoKey()
                  setOpen(false)
                }}
              >
                Forget this key
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 pt-3">
              <p className="text-body text-ink-2">
                Paste a testnet key to sign trove ballots in the tab, without a wallet extension. Use a
                throwaway key: the key is held in memory, never in storage, and forgotten on reload.
              </p>
              <input
                type="password"
                className="field h-8 text-meta"
                placeholder="0x… 32-byte private key"
                value={value}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                }}
              />
              {error ? <span className="figure text-label text-vermilion">{error}</span> : null}
              <div className="flex items-center gap-2">
                <button type="button" className="btn border-amber/60 text-amber" onClick={submit}>
                  Use key
                </button>
                <a
                  className="link text-label"
                  href="https://explorer.test.mezo.org"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  testnet only
                </a>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
