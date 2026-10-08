'use client'

/** The browser's print dialog, where "Save as PDF" is one of the printers. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} style={{ width: 'auto' }}>
      Print or save as PDF
    </button>
  )
}
