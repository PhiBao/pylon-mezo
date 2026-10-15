import type { NextConfig } from 'next'

/**
 * Pylon ships as a static bundle: the terminal is a pure client of the Pylon engine API and of
 * Mezo Testnet RPC. `output: 'export'` keeps deployment trivial (any bucket/CDN) and removes any
 * server-side trust surface from the frontend.
 */
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig
