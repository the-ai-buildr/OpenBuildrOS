import type { Metadata, Viewport } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'OpenBuildrOS',
  description: 'Open source agent builder platform on Agno AgentOS.',
  icons: { icon: '/icon.svg' },
}

export const viewport: Viewport = { themeColor: '#0e1116' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
