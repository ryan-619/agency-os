import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server bundle so the runtime image does not need
  // node_modules. See Dockerfile.
  output: 'standalone',
  // The monorepo root, so tracing picks up the workspace packages.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // pg and nodemailer are native/CJS server-only packages; keep them external
  // to the bundle rather than letting the compiler try to trace into them.
  serverExternalPackages: ['pg', 'nodemailer'],
}

export default config
