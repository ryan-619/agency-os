import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { GeistMono } from 'geist/font/mono'
import { GeistSans } from 'geist/font/sans'
import { MotionRoot } from '@/components/motion/motion-root'
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

/**
 * Before the first paint: says whether this visitor's system allows motion,
 * so the few headings that animate in can wait hidden for their animation
 * instead of showing, vanishing and animating (`.motion-ok [data-split]` in
 * globals.css). Nothing else depends on it, and a visitor who asked for less
 * motion never gets the class. Inline because it must run before the page is
 * painted; it reads a media query and writes one class, and nothing else.
 */
const MOTION_CLASS = `try{if(matchMedia('(prefers-reduced-motion: no-preference)').matches)document.documentElement.classList.add('motion-ok')}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The class above is added before React hydrates <html>, so this element alone may differ.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        {/* Next puts a beforeInteractive script in the document head, ahead of everything React renders. */}
        <Script id="motion-ok" strategy="beforeInteractive">
          {MOTION_CLASS}
        </Script>
        {children}
        <MotionRoot />
      </body>
    </html>
  )
}
