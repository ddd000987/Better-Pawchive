/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Settings center: manual pick controls on the crawl page (mode switch, how
 * many posts are picked, save to cache, clear). The mode is per tab and not a
 * saved setting, so it has its own row instead of checkRow. */

import { manualPick } from '../../crawl/ManualPick'
import { EVT } from '../../EVT'
import { lang } from '../../Language'
import type { LangTextKey } from '../../localeTypes'

export function buildManualPick(host: HTMLDivElement): void {
  // Mode switch
  const row = document.createElement('label')
  row.className = 'pwpSC-row'
  row.dataset.key = '_f_manualPick'
  row.dataset.desc = '_d_manualPick'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = manualPick.active
  box.addEventListener('change', () => manualPick.setActive(box.checked))
  const text = document.createElement('span')
  text.dataset.xztext = '_f_manualPick'
  text.textContent = lang.transl('_f_manualPick')
  row.append(box, text)
  host.appendChild(row)

  // Picked count + buttons (shown while the mode is on or something is picked)
  const actions = document.createElement('div')
  actions.className = 'pwpSC-row pwpSC-btnRow'
  actions.dataset.key = '_pickSave'
  const count = document.createElement('span')
  const mk = (labelKey: LangTextKey, onClick: () => void) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.xztext = labelKey
    btn.textContent = lang.transl(labelKey)
    btn.addEventListener('click', onClick)
    return btn
  }
  const save = mk('_pickSave', () => void manualPick.save())
  const clear = mk('_pickClear', () => manualPick.clear())
  actions.append(count, save, clear)
  host.appendChild(actions)

  const refresh = () => {
    box.checked = manualPick.active
    const n = manualPick.count
    actions.style.display = manualPick.active || n > 0 ? '' : 'none'
    count.textContent = lang.transl('_pickCount', String(n))
    save.disabled = !manualPick.canSave
    clear.disabled = n === 0
  }
  EVT.on(EVT.list.manualPickChange, refresh)
  refresh()
}
