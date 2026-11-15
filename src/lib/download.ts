/** Saves text as a file. CSV text carries its own byte-order mark (see csv.ts). */
export function downloadText(name: string, text: string, type = 'text/csv') {
  downloadBlob(name, new Blob([text], { type: type === 'text/csv' ? 'text/csv;charset=utf-8' : type }))
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadUrl(name: string, url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}
