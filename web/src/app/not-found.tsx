import Link from 'next/link'
import { PylonMark } from '@/components/shell/Wordmark'

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-[1560px] flex-col gap-4 border-x border-rule px-4 py-20">
      <span className="etched">404 · no such instrument</span>
      <h1 className="max-w-[36ch] text-h1 text-ink">
        That route does not exist. The redemption queue, however, is always at the terminal.
      </h1>
      <div className="flex items-center gap-3 pt-2">
        <Link href="/" className="link figure text-meta">
          Back to the terminal
        </Link>
        <PylonMark size={16} className="text-ink-3" />
      </div>
    </div>
  )
}
