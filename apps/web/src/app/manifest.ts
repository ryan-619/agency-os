import type { MetadataRoute } from 'next'

/**
 * The web app manifest (2026-10-08): installs Agency OS on a phone's home
 * screen as an app of its own — its own icon, no browser bar — opening at the
 * dashboard. Public in `proxy.ts` with the icons, because a browser fetches
 * them without the session cookie.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agency OS',
    short_name: 'Agency OS',
    description: 'The agency’s CRM, outreach and pipeline — with the assistant that runs them.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#111827',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
