/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Save data as a JSON file the user downloads, and let the user pick a
 * text file to read back. */

/** Offer `data` as a JSON file download named `filename` */
export function saveJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  // The anchor stays detached: nothing is added to the page DOM, so the page
  // cannot observe the blob URL or the click.
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/** Let the user pick a JSON file and call `onText` with its contents. Nothing
 * happens when the picker is cancelled. */
export function pickJsonFile(onText: (text: string) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) {
      void file.text().then(onText)
    }
  })
  input.click()
}

/** A file name part made from free text (a title): no path or reserved
 * characters, at most 60 characters (may be empty) */
export function fileNamePart(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
  )
}
