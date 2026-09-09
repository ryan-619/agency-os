/**
 * Auth.js v5 mounts both GET and POST from the same `handlers` object.
 *
 * Pinned to the Node runtime: next-auth's own JSDoc still suggests
 * `runtime = "edge"`, which is wrong for this stack — the Drizzle/pg adapter
 * and nodemailer are Node-only.
 */
export const runtime = 'nodejs'
export { GET, POST } from '@/auth'
