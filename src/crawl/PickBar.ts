/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Manual pick: a bar fixed at the bottom centre of the screen that shows how
 * many posts are picked. Shown only while something is picked, so picking
 * many cards in a row gives one steady counter instead of a toast per click. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { keepInBody } from '../PageRoots'
import { manualPick } from './ManualPick'

class PickBar {
  private bar: HTMLDivElement | null = null

  constructor() {
    EVT.on(EVT.list.manualPickChange, () => this.render())
  }

  private render(): void {
    const n = manualPick.count
    if (n === 0) {
      if (this.bar) this.bar.style.display = 'none'
      return
    }
    if (!this.bar) {
      this.bar = document.createElement('div')
      this.bar.id = 'pwpPickBar'
      document.body.appendChild(this.bar)
      keepInBody(this.bar)
    }
    this.bar.textContent = lang.transl('_pickCount', String(n))
    this.bar.style.display = ''
  }
}

const pickBar = new PickBar()
export { pickBar }
