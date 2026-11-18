/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* 設定中心：預覽設定分頁（開關、懸停延遲、資訊列欄位位置） */

import { lang } from '../../Language'
import { LangTextKey } from '../../langText'
import {
  PREVIEW_INFO_FIELDS,
  PREVIEW_INFO_PLACES,
} from '../../preview/previewInfo'
import type {
  PreviewInfoField,
  PreviewInfoPlace,
} from '../../preview/previewInfo'
import { HotkeyEditor } from '../HotkeyEditor'
import { settings, PreviewSettings } from '../Settings'
import { checkRow, inputRow, section, tipCard } from './controls'

/** 預覽設定鍵的文案 key */
const PREVIEW_LABELS: Record<keyof PreviewSettings, LangTextKey> = {
  PreviewWork: '_f_PreviewWork',
  previewWorkWait: '_f_previewWorkWait',
  previewOriginalImage: '_f_previewOriginalImage',
  showPreviewWorkTip: '_f_showPreviewWorkTip',
  keepPreviewOnFloatHover: '_f_keepPreviewOnFloatHover',
  previewInfoPlacement: '_previewInfoTitle',
  allowPreviewCoverThumbnail: '_f_allowPreviewCoverThumbnail',
  wheelScrollSwitchImageOnPreviewWork: '_f_wheelScroll',
  wheelScrollPageMoveDistance: '_f_wheelScrollPageMoveDistance',
  previewPreloadNext: '_f_previewPreloadNext',
  previewPreloadPrev: '_f_previewPreloadPrev',
  showDownloadBtnOnThumb: '_f_showDownloadBtnOnThumb',
  PreviewCreator: '_f_PreviewCreator',
  previewCreatorCount: '_f_previewCreatorCount',
  keepCreatorPreviewOnFloatHover: '_f_keepCreatorPreviewOnFloatHover',
}

/** 純布林的預覽鍵（數字鍵與物件型鍵另有專屬控件） */
const PREVIEW_BOOL_KEYS: Array<
  Exclude<
    keyof PreviewSettings,
    | 'previewWorkWait'
    | 'wheelScrollPageMoveDistance'
    | 'previewPreloadNext'
    | 'previewPreloadPrev'
    | 'previewInfoPlacement'
    | 'PreviewCreator'
    | 'previewCreatorCount'
    | 'keepCreatorPreviewOnFloatHover'
  >
> = [
  'PreviewWork',
  'previewOriginalImage',
  'showPreviewWorkTip',
  'keepPreviewOnFloatHover',
  'allowPreviewCoverThumbnail',
  'wheelScrollSwitchImageOnPreviewWork',
  'showDownloadBtnOnThumb',
]

/** 資訊列欄位的名稱文案 key */
const INFO_LABELS: Record<PreviewInfoField, LangTextKey> = {
  index: '_pi_index',
  title: '_pi_title',
  creator: '_pi_creator',
  service: '_pi_service',
  postId: '_pi_postId',
  date: '_pi_date',
  files: '_pi_files',
  pendingOnly: '_pi_pendingOnly',
  keys: '_pi_keys',
}

/** 位置（上方／下方／不顯示）的文案 key */
const PLACE_LABELS: Record<PreviewInfoPlace, LangTextKey> = {
  top: '_pi_top',
  bottom: '_pi_bottom',
  none: '_pi_none',
}

export function buildPreview(host: HTMLDivElement): void {
  const body = section(host, '_previewSettings')
  tipCard(body, '_sc_previewTip')
  for (const key of PREVIEW_BOOL_KEYS) {
    checkRow(body, key, PREVIEW_LABELS[key])
  }
  // 懸停延遲（ms）
  inputRow(
    body,
    'previewWorkWait',
    PREVIEW_LABELS.previewWorkWait,
    'number',
    undefined,
    { min: '0', max: '2000', step: '50' }
  )
  // 滑鼠移動多少像素後，預覽中的滾輪改為捲動網頁
  inputRow(
    body,
    'wheelScrollPageMoveDistance',
    PREVIEW_LABELS.wheelScrollPageMoveDistance,
    'number',
    undefined,
    { min: '1', max: '2000', step: '5' }
  )
  // How many images on each side of the current one load ahead of time
  for (const key of ['previewPreloadNext', 'previewPreloadPrev'] as const) {
    inputRow(body, key, PREVIEW_LABELS[key], 'number', undefined, {
      min: '0',
      max: '10',
      step: '1',
    })
  }

  // Keys used inside the preview: rebind, or clear one to turn it off
  const keysBody = section(host, '_secPreviewHotkeys')
  tipCard(keysBody, '_previewHotkeysTip')
  const keysMount = document.createElement('div')
  keysMount.className = 'pwpSC-row'
  keysMount.dataset.key = '_secPreviewHotkeys'
  keysBody.appendChild(keysMount)
  new HotkeyEditor(keysMount, 'preview')

  // Creator page preview (hover a creator avatar)
  const creatorBody = section(host, '_secCreatorPreview')
  checkRow(creatorBody, 'PreviewCreator', PREVIEW_LABELS.PreviewCreator)
  checkRow(
    creatorBody,
    'keepCreatorPreviewOnFloatHover',
    PREVIEW_LABELS.keepCreatorPreviewOnFloatHover
  )
  inputRow(
    creatorBody,
    'previewCreatorCount',
    PREVIEW_LABELS.previewCreatorCount,
    'number',
    undefined,
    { min: '1', max: '50', step: '1' }
  )

  // 資訊列內容：每個欄位獨立選「上方／下方／不顯示」
  const infoBody = section(host, '_previewInfoTitle')
  tipCard(infoBody, '_previewInfoHint')
  for (const field of PREVIEW_INFO_FIELDS) {
    const row = document.createElement('label')
    row.className = 'pwpSC-row pwpSC-field'
    row.dataset.key = `previewInfoPlacement.${field}`
    row.dataset.desc = '_d_previewInfoPlacement'
    const name = document.createElement('span')
    name.dataset.xztext = INFO_LABELS[field]
    name.textContent = lang.transl(INFO_LABELS[field])
    const select = document.createElement('select')
    select.dataset.pfield = field
    for (const place of PREVIEW_INFO_PLACES) {
      const opt = document.createElement('option')
      opt.value = place
      opt.dataset.xztext = PLACE_LABELS[place]
      opt.textContent = lang.transl(PLACE_LABELS[place])
      select.appendChild(opt)
    }
    select.value = settings.get('previewInfoPlacement')[field]
    select.addEventListener('change', () => {
      settings.set('previewInfoPlacement', {
        ...settings.get('previewInfoPlacement'),
        [field]: select.value as PreviewInfoPlace,
      })
    })
    row.append(name, select)
    infoBody.appendChild(row)
  }
}
