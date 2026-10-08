import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Agency OS',
  description: 'The agency’s internal operating system: CRM, outreach, pipeline and the assistant that runs them.',
  // Installed on a phone's home screen, it opens as an app of its own (`manifest.ts`).
  appleWebApp: { capable: true, title: 'Agency OS', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#111827',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
