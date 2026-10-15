import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { AppFooter } from '@/components/shell/AppFooter'
import { AppHeader } from '@/components/shell/AppHeader'
import { Providers } from '@/state/providers'
import './globals.css'

/**
 * Fonts are self-hosted (variable woff2, latin subset) so the static bundle never reaches out to a
 * font CDN at runtime and the build is reproducible without network access.
 */
const spaceGrotesk = localFont({
  src: '../fonts/space-grotesk.woff2',
  variable: '--font-space-grotesk',
  weight: '300 700',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
})

const inter = localFont({
  src: '../fonts/inter.woff2',
  variable: '--font-inter',
  weight: '100 900',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
})

const jetbrainsMono = localFont({
  src: '../fonts/jetbrains-mono.woff2',
  variable: '--font-jetbrains',
  weight: '100 800',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'monospace'],
})

export const metadata: Metadata = {
  title: 'Pylon — redemption terminal for Mezo bitcoin CDPs',
  description:
    'Pylon is a non-custodial execution engine for Mezo: flash loop, flash unwind and flash exit any bitcoin trove, watch your exact position in the SortedTroves redemption queue, and shield it with a MUSD reserve.',
  applicationName: 'Pylon',
  keywords: [
    'Mezo',
    'bitcoin',
    'MUSD',
    'CDP',
    'redemption',
    'flash loan',
    'Tigris',
    'DeFi',
    'x402',
  ],
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon.svg', type: 'image/svg+xml', sizes: '32x32' },
    ],
    shortcut: '/favicon.svg',
    apple: '/apple-icon.svg',
  },
  openGraph: {
    title: 'Pylon — redemption terminal for Mezo bitcoin CDPs',
    description:
      'Flash loop, unwind and exit bitcoin troves in one atomic transaction, and see your exact place in the redemption queue.',
    type: 'website',
  },
}

export const viewport: Viewport = {
  themeColor: '#0A0B0D',
  colorScheme: 'dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <div className="flex min-h-screen flex-col">
            <AppHeader />
            <main className="flex-1">{children}</main>
            <AppFooter />
          </div>
        </Providers>
      </body>
    </html>
  )
}
