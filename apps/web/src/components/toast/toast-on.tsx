'use client'

import { useEffect } from 'react'
import { toast, type ToastTone } from './toast'

/**
 * Shows `message` as a pop-up each time it becomes a new non-empty value,
 * and renders nothing. A form keeps its own state for what it last did —
 * cleared when an action starts, set when it lands — and this turns that
 * moment into a toast where a line of text under the form used to appear.
 */
export function ToastOn({ message, tone = 'success' }: { readonly message: string | null | undefined | false; readonly tone?: ToastTone }) {
  useEffect(() => {
    if (message) toast(message, tone)
  }, [message, tone])
  return null
}
