#!/usr/bin/env node
/**
 * Build both network bundles into one static export.
 *
 *   /            Mezo Testnet (31611) + the hosted engine
 *   /mainnet/    Mezo mainnet (31612), RPC-only
 *
 * Each bundle is prerendered with its own deployment and chain, so the header, footer, explorer
 * links and every address agree with the network on screen — no runtime switch, no hydration
 * mismatch. The mainnet bundle is built first with a base path, moved aside, then copied under
 * `out/mainnet` after the testnet build.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const out = join(root, 'out')
const mainnetOut = join(root, 'out-mainnet')

const build = (env) =>
  execFileSync('pnpm', ['exec', 'next', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })

rmSync(mainnetOut, { recursive: true, force: true })

console.log('\n=== mainnet bundle (chain 31612, RPC-only, /mainnet) ===')
build({
  NEXT_PUBLIC_NETWORK: 'mainnet',
  NEXT_PUBLIC_BASE_PATH: '/mainnet',
  NEXT_PUBLIC_API_BASE: '',
})

if (!existsSync(out)) throw new Error('mainnet build produced no out/ directory')
renameSync(out, mainnetOut)

console.log('\n=== testnet bundle (chain 31611, engine API, /) ===')
build({
  NEXT_PUBLIC_NETWORK: '',
  NEXT_PUBLIC_BASE_PATH: '',
  ...(process.env.NEXT_PUBLIC_API_BASE ? {} : {}),
})

cpSync(mainnetOut, join(out, 'mainnet'), { recursive: true })
rmSync(mainnetOut, { recursive: true, force: true })

console.log('\nstatic export ready: out/ (testnet) + out/mainnet/ (mainnet)')
