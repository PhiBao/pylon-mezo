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
  // Set NEXT_PUBLIC_BASE_PATH when the bundle is hosted under a sub-path (e.g. GitHub Pages serves
  // project sites from /<repo>). Empty for a root deployment.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
}

export default nextConfig
