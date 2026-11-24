/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* 設定中心：下載頁下方的下載佇列區塊（狀態、開始／暫停、排序／移除） */

import { downloadQueue } from '../../download/DownloadQueue'
import { lang } from '../../Language'
import { LangTextKey } from '../../localeTypes'
import { section, tipCard } from './controls'
import type { CenterContext } from './context'

export class QueueView {
  private queueList!: HTMLDivElement

  constructor(private readonly ctx: CenterContext) {}

  public build(host: HTMLDivElement): void {
    const body = section(host, '_secQueue')
    tipCard(body, '_queueTip')
    this.queueList = document.createElement('div')
    body.appendChild(this.queueList)
    this.render()
  }

  /** 重繪下載佇列（佇列異動／切換語言時呼叫） */
  public render(): void {
    if (!this.queueList) {
      return
    }
    this.queueList.innerHTML = ''
    const list = downloadQueue.list()
    const running = downloadQueue.isRunning()
    const mkBtn = (
      labelKey: LangTextKey,
      onClick: () => void
    ): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.xztext = labelKey
      btn.textContent = lang.transl(labelKey)
      btn.addEventListener('click', onClick)
      return btn
    }
    const status = document.createElement('div')
    status.className = 'pwpSC-row pwpSC-status'
    status.textContent = running
      ? lang.transl('_queueStateRunning')
      : lang.transl(
          '_queueStateIdle',
          String(list.filter((i) => i.status === 'waiting').length)
        )
    this.queueList.appendChild(status)
    const controls = document.createElement('div')
    controls.className = 'pwpSC-row pwpSC-btnRow'
    const toggleBtn = running
      ? mkBtn('_queuePause', () => downloadQueue.pause())
      : mkBtn('_queueStart', () => void downloadQueue.start())
    const clearBtn = mkBtn('_queueClearFinished', () =>
      downloadQueue.clearFinished()
    )
    controls.append(toggleBtn, clearBtn)
    this.queueList.appendChild(controls)
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'pwpSC-row pwpSC-status'
      empty.dataset.xztext = '_queueNone'
      empty.textContent = lang.transl('_queueNone')
      this.queueList.appendChild(empty)
      this.ctx.reapplySearch()
      return
    }
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const id = item.cacheId
      const card = document.createElement('div')
      card.className =
        'pwpSC-row pwpSC-cacheCard' +
        (item.status === 'running' ? ' mounted' : '')
      const head = document.createElement('div')
      head.className = 'pwpSC-cacheTitle'
      head.textContent = `${i + 1}. ${item.title}`
      const meta = document.createElement('div')
      meta.className = 'pwpSC-row pwpSC-status'
      meta.textContent = lang.transl(`_queueSt_${item.status}` as LangTextKey)
      const row = document.createElement('div')
      row.className = 'pwpSC-row pwpSC-btnRow'
      const upBtn = mkBtn('_queueUp', () => {
        downloadQueue.move(id, -1)
      })
      if (i === 0) {
        upBtn.disabled = true
      }
      const downBtn = mkBtn('_queueDown', () => {
        downloadQueue.move(id, 1)
      })
      if (i === list.length - 1) {
        downBtn.disabled = true
      }
      const removeBtn = mkBtn(
        '_queueRemove',
        () => void downloadQueue.remove(id)
      )
      if (item.status === 'running') {
        removeBtn.disabled = true
        removeBtn.title = lang.transl('_queueRemoveRunning')
      }
      row.append(upBtn, downBtn, removeBtn)
      card.append(head, meta, row)
      this.queueList.appendChild(card)
    }
    this.ctx.reapplySearch()
  }
}
