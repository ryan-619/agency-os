import 'server-only'

/**
 * The secret comparison a route imports. The functions live in
 * `lib/secret-compare.ts`, which carries no `server-only` marker so the
 * test suite can exercise them; this module is the same two functions with
 * the marker, so a client component that reaches for `secretMatches` fails
 * the build instead of shipping a constant-time compare to the browser —
 * where "constant time" means nothing and the expected value would be in
 * the bundle.
 */
export { secretMatches, bearerFrom, bearerFromHeader } from './secret-compare'
