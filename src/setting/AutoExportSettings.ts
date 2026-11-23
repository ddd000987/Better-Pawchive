/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader AutoExportSettings concept
 *          (xuejianxianzun)
 * changes: minimal version — export all keys as JSON via a detached anchor
 *          download; import validates keys against defaults before
 *          applying. Exports carry a schemaVersion; imports without one are
 *          treated as legacy and migrated.
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { log } from '../Log'
import { toast } from '../Toast'
import {
  defaultSettings,
  parseStoredSettings,
  SETTINGS_SCHEMA_VERSION,
  settings,
} from './Settings'

class AutoExportSettings {
  constructor() {
    this.bindEvents()
  }

  private bindEvents() {
    EVT.on(EVT.list.exportSettings, () => {
      const data: Record<string, unknown> = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
      }
      for (const key of Object.keys(defaultSettings)) {
        data[key] = settings.get(key as keyof typeof defaultSettings)
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      // The anchor stays detached: nothing is added to the page DOM, so the
      // page cannot observe the blob URL or the click.
      const a = document.createElement('a')
      a.href = url
      a.download = `pawchive-settings-${Date.now()}.json`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 3000)
      toast.show(lang.transl('_settingsExported'))
    })

    EVT.on(EVT.list.importSettings, () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) {
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const parsed = JSON.parse(reader.result as string) as unknown
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed)
            ) {
              throw new Error('not an object')
            }
            // Migrates old exports (no schemaVersion), sanitizes every key and
            // fixes cross-key conflicts (hotkey duplicates, min > max files)
            const data = parseStoredSettings(parsed, settings.snapshot())
            let n = 0
            for (const key of Object.keys(data) as Array<
              keyof typeof defaultSettings
            >) {
              settings.set(key, data[key] as never)
              n++
            }
            if (n === 0) {
              throw new Error('no known keys')
            }
            toast.show(lang.transl('_settingsImported'))
            log.success(lang.transl('_settingsImported'))
          } catch {
            toast.error(lang.transl('_settingsImportFailed'))
          }
        }
        reader.readAsText(file)
      })
      input.click()
    })
  }
}

new AutoExportSettings()
