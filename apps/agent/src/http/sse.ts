/**
 * Server-sent events, written out by hand (PROMPT.md §5.2).
 *
 * No framework, because the whole protocol is four lines of text per frame and
 * a header block, and this process already runs a `node:http` server for
 * health checks. What the format cannot express is handled here rather than
 * hidden in a library:
 *
 *  - **Proxies drop idle connections.** An agent thinking for ninety seconds
 *    looks exactly like an idle connection to nginx, which closes it at 60 by
 *    default. A comment frame every fifteen seconds keeps it open and costs
 *    nothing.
 *  - **Buffering defeats streaming.** `X-Accel-Buffering: no` tells nginx not
 *    to accumulate the response, and disabling Nagle stops the kernel from
 *    doing the same thing one layer down. Without both, the tokens arrive in
 *    one lump at the end and the stream was pointless.
 *  - **A browser that closes mid-turn must not take the turn with it.** The
 *    writer stops writing; the turn keeps running, keeps spending money it has
 *    already committed, and keeps persisting. That is what makes reattaching
 *    possible at all.
 */
import type { ServerResponse } from 'node:http'
import { SSE_KEEPALIVE, encodeSse, type ChatEvent } from '@agency/core'

export const KEEPALIVE_MS = 15_000

export interface SseWriter {
  send(event: ChatEvent): void
  close(): void
  readonly open: boolean
}

export function startSse(res: ServerResponse): SseWriter {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx buffers a proxied response by default, which turns a token stream
    // into one delivery at the end.
    'x-accel-buffering': 'no',
  })
  // And the kernel does the same thing a layer down.
  res.socket?.setNoDelay(true)

  let open = true
  const keepalive = setInterval(() => {
    if (open) res.write(SSE_KEEPALIVE)
  }, KEEPALIVE_MS)

  const stop = (): void => {
    if (!open) return
    open = false
    clearInterval(keepalive)
  }

  // The browser went away. Stop writing; do NOT stop the turn.
  res.on('close', stop)
  res.on('error', stop)

  return {
    get open() {
      return open
    },
    send(event) {
      if (!open) return
      res.write(encodeSse(event))
    },
    close() {
      if (!open) return
      stop()
      res.end()
    },
  }
}
