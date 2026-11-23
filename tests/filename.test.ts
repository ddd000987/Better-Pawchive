import { beforeEach, describe, expect, it } from 'vitest'
import { Config } from '../src/Config'
import { fileName } from '../src/filename/FileName'
import { settings } from '../src/setting/Settings'
import type { Result } from '../src/store/StoreType'

const LIMIT = Config.fullNameLengthLimit

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length
}

/** 檢查是否有落單的代理項（截斷切斷 emoji 會產生） */
function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true
      }
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function result(overrides: Partial<Result> = {}): Result {
  return {
    id: 'patreon/u1/999#0',
    postKey: 'patreon/u1/999',
    service: 'patreon',
    creator: 'some artist',
    creatorId: 'u1',
    postId: '999',
    title: 'my title',
    published: '2024-01-02T03:04:05',
    fileCount: 2,
    pending: false,
    fileUrl: 'https://n1.kemono.cr/data/a.png',
    fileName: 'a.png',
    ext: 'png',
    kind: 'image',
    previewOnly: false,
    textData: '',
    fileIndex: 0,
    ...overrides,
  }
}

const DEFAULT_RULE =
  'kemono/{service}/{creator}-{creator_id}/{post_id}-{title}/{index}-{file_name}.{ext}'

describe('fileName.createFileName', () => {
  beforeEach(() => {
    settings.set('namingRule', DEFAULT_RULE)
    settings.set('namingRulePawchive', '')
  })

  it('預設規則含服務/創作者/帖子/序號', () => {
    expect(fileName.createFileName(result())).toBe(
      'kemono/patreon/some artist-u1/999-my title/0-a.png'
    )
  })

  it('非法字元全形化', () => {
    const name = fileName.createFileName(
      result({ title: 'a/b:c', fileName: 'x?.png' })
    )
    expect(name).toBe('kemono/patreon/some artist-u1/999-a／b：c/0-x？.png')
  })

  it('過長截斷且保留副檔名與 postId', () => {
    const name = fileName.createFileName(
      result({ title: 't'.repeat(300), fileName: `${'f'.repeat(300)}.png` })
    )
    expect(name.length).toBeLessThanOrEqual(210)
    expect(name.endsWith('.png')).toBe(true)
    expect(name).toContain('999')
  })

  it('自訂規則與 token（日期拆分/kind）', () => {
    settings.set(
      'namingRule',
      '{service}/{date}/{post_id}-{kind}-{index}.{ext}'
    )
    expect(fileName.createFileName(result())).toBe(
      'patreon/2024-01-02/999-image-0.png'
    )
  })

  it('可選片段 [...]：空標記整段移除', () => {
    settings.set('namingRule', '{post_id}[{title}-]{index}.{ext}')
    expect(fileName.createFileName(result())).toBe('999my title-0.png')
    // date 為空（published 缺失）時整段消失
    settings.set('namingRule', '{post_id}[{date}-]{index}.{ext}')
    expect(fileName.createFileName(result({ published: '' }))).toBe('9990.png')
    expect(fileName.createFileName(result())).toBe('9992024-01-02-0.png')
  })

  it('規則沒寫 {ext} 自動補副檔名', () => {
    settings.set('namingRule', '{post_id}/{index}-{file_name}')
    expect(fileName.createFileName(result())).toBe('999/0-a.png')
  })

  it('Pawchive 站專用規則覆寫', () => {
    settings.set('namingRulePawchive', 'pw/{post_id}.{ext}')
    expect(fileName.createFileName(result(), 'pawchive.pw')).toBe('pw/999.png')
    // Kemono 站不受影響
    expect(fileName.createFileName(result(), 'kemono.su')).toBe(
      'kemono/patreon/some artist-u1/999-my title/0-a.png'
    )
  })

  it('sanitizes the literal text of the rule, keeping "/" as the separator', () => {
    settings.set(
      'namingRule',
      '{creator}:{title}/a*b?c"d<e>f|g\\h/{index}.{ext}'
    )
    expect(fileName.createFileName(result())).toBe(
      'some artist：my title/a＊b？c＂d＜e＞f｜g＼h/0.png'
    )
  })

  it('keeps "~" in the literal text of the rule (valid in file names)', () => {
    settings.set('namingRule', '{post_id}~{index}.{ext}')
    expect(fileName.createFileName(result())).toBe('999~0.png')
  })

  it('strips control characters from the literal text of the rule', () => {
    settings.set('namingRule', 'x\u0000y\u001f/{index}\t.{ext}')
    expect(fileName.createFileName(result())).toBe('xy/0.png')
  })

  it('findUnsafeRuleChars ignores tags and lists each bad character once', () => {
    expect(fileName.findUnsafeRuleChars(DEFAULT_RULE)).toEqual([])
    expect(
      fileName.findUnsafeRuleChars('{creator}:{title}/a:b*c\u0001')
    ).toEqual([':', '*', '\u0001'])
  })

  it('未知 token 原樣保留（不吞字）', () => {
    settings.set('namingRule', '{post_id}-{foo}.{ext}')
    expect(fileName.createFileName(result())).toBe('999-{foo}.png')
  })

  it('規則清空回退預設（不產出 .png 垃圾檔名）', () => {
    settings.set('namingRule', '   ')
    expect(fileName.createFileName(result())).toBe(
      'kemono/patreon/some artist-u1/999-my title/0-a.png'
    )
  })

  it('未閉合方括號原樣保留', () => {
    settings.set('namingRule', '{post_id}[{index}.{ext}')
    expect(fileName.createFileName(result())).toBe('999[0.png')
  })

  it('「..」標題不產生路徑穿越段', () => {
    const name = fileName.createFileName(result({ title: '..' }))
    expect(name.split('/')).not.toContain('..')
    expect(name.split('/')).not.toContain('.')
  })

  it('Windows 保留名（含 COM5-9/LPT4-9）不直接落地', () => {
    settings.set('namingRule', '{file_name}.{ext}')
    // Reserved name with an extension: the stem is extended, so Windows can
    // create the file and it keeps its extension
    expect(
      fileName.createFileName(result({ fileName: 'COM5.png', ext: 'png' }))
    ).toBe('COM5[WindowsReservedName].png')
    expect(
      fileName.createFileName(result({ fileName: 'LPT9.zip', ext: 'zip' }))
    ).toBe('LPT9[WindowsReservedName].zip')
  })

  it('標記值中的 token 或 $& 不被二次解析', () => {
    settings.set('namingRule', '{title}-{file_name}.{ext}')
    const name = fileName.createFileName(
      result({ title: '$&{index}', fileName: 'a.png' })
    )
    expect(name).toBe('$&{index}-a.png')
  })

  it('result.ext 缺失時由原名推回，不產生雙副檔名', () => {
    settings.set('namingRule', '{file_name}.{ext}')
    const name = fileName.createFileName(
      result({ fileName: 'photo.png', ext: '' })
    )
    expect(name).toBe('photo.png')
  })

  it('規則不含 {ext} 時只用推回的副檔名補一次', () => {
    settings.set('namingRule', '{file_name}')
    const name = fileName.createFileName(
      result({ fileName: 'photo.png', ext: '' })
    )
    expect(name).toBe('photo.png')
  })

  it('副檔名含正則特殊字元時不拋錯且不多接副檔名', () => {
    settings.set('namingRule', '{file_name}.{ext}')
    const name = fileName.createFileName(
      result({ fileName: 'a.c++', ext: 'c++' })
    )
    expect(name).toBe('a.c++')
  })

  it('不安全的 ext 會全形化，不會變成路徑分隔', () => {
    settings.set('namingRule', '{file_name}.{ext}')
    const name = fileName.createFileName(result({ fileName: 'a', ext: 'p/ng' }))
    expect(name).toBe('a.p／ng')
  })
})

describe('fileName.lengthLimit（UTF-8 位元組）', () => {
  beforeEach(() => {
    settings.set('namingRule', DEFAULT_RULE)
    settings.set('namingRulePawchive', '')
  })

  it('CJK 標題按位元組截斷且不切斷字元', () => {
    const name = fileName.createFileName(
      result({ title: '貓'.repeat(200), fileName: '檔案.png' })
    )
    expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
    expect(name.endsWith('.png')).toBe(true)
    expect(name).toContain('999')
    expect(name).not.toContain('\uFFFD')
    expect(hasLoneSurrogate(name)).toBe(false)
  })

  it('keeps the files of a long-title post distinct and in one folder', () => {
    const base = { postId: '12345678', title: '貓'.repeat(60) }
    const files = [
      { fileName: 'a.png', fileIndex: 0 },
      { fileName: 'b.png', fileIndex: 1 },
      { fileName: 'a-much-longer-original-file-name.png', fileIndex: 12 },
    ]
    const names = files.map((file) =>
      fileName.createFileName(result({ ...base, ...file }))
    )

    for (const name of names) {
      expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
      expect(name.endsWith('.png')).toBe(true)
    }
    expect(new Set(names).size).toBe(names.length)
    const leaf = (name: string) => name.slice(name.lastIndexOf('/') + 1)
    const folder = (name: string) => name.slice(0, name.lastIndexOf('/'))
    // The `{index}-` prefix and short original names survive
    expect(leaf(names[0])).toBe('0-a.png')
    expect(leaf(names[1])).toBe('1-b.png')
    expect(leaf(names[2]).startsWith('12-')).toBe(true)
    // Folder truncation must not depend on the file part
    expect(new Set(names.map(folder)).size).toBe(1)
    expect(folder(names[0])).toContain('12345678')
  })

  it('keeps one folder per post at every title length, whatever the file name', () => {
    const folder = (name: string) => name.slice(0, name.lastIndexOf('/'))
    for (let length = 20; length < 200; length++) {
      const base = { postId: '9876543', title: 't'.repeat(length) }
      const names = [
        { fileName: 'a.png', ext: 'png', fileIndex: 0 },
        { fileName: 'n'.repeat(120) + '.png', ext: 'png', fileIndex: 1 },
        { fileName: 'b.jpeg', ext: 'jpeg', fileIndex: 2 },
        { fileName: 'c.mp4', ext: 'mp4', fileIndex: 3 },
      ].map((file) => fileName.createFileName(result({ ...base, ...file })))
      for (const name of names) {
        expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
      }
      expect(new Set(names.map(folder)).size, `title length ${length}`).toBe(1)
    }
  })

  it('keeps the post id when it sits at the end of a truncated folder', () => {
    settings.set(
      'namingRule',
      '{creator}/{title}-{post_id}/{index}-{file_name}.{ext}'
    )
    const title = 'ア'.repeat(70)
    const first = fileName.createFileName(
      result({ postId: '9876543', title, fileName: 'a.png' })
    )
    const second = fileName.createFileName(
      result({ postId: '9876544', title, fileName: 'a.png' })
    )
    expect(byteLength(first)).toBeLessThanOrEqual(LIMIT)
    expect(first).toContain('9876543')
    expect(second).toContain('9876544')
    expect(first).not.toBe(second)
    expect(first.endsWith('/0-a.png')).toBe(true)
  })

  it('cuts a long file part from the end and keeps the folders whole', () => {
    const name = fileName.createFileName(
      result({ title: 'short', fileName: 'x'.repeat(300) + '.png' })
    )
    expect(byteLength(name)).toBe(LIMIT)
    expect(name.startsWith('kemono/patreon/some artist-u1/999-short/0-x')).toBe(
      true
    )
    expect(name.endsWith('.png')).toBe(true)
  })

  it('adds the id to the file part when no folder carries it', () => {
    settings.set('namingRule', '{creator}/{index}-{title}.{ext}')
    const name = fileName.createFileName(
      result({ postId: '12345678', title: '題'.repeat(100), fileIndex: 3 })
    )
    expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
    const leaf = name.slice(name.lastIndexOf('/') + 1)
    expect(leaf.startsWith('3-題')).toBe(true)
    expect(leaf.endsWith('-12345678….png')).toBe(true)
  })

  it('emoji（代理對）不被截斷成半個', () => {
    settings.set('namingRule', '{title}/{post_id}.{ext}')
    const name = fileName.createFileName(
      result({ title: '🐱'.repeat(100), fileName: 'a.png' })
    )
    expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
    expect(name.endsWith('/999.png')).toBe(true)
    expect(name).not.toContain('\uFFFD')
    expect(hasLoneSurrogate(name)).toBe(false)
  })

  it('超長單層目錄截斷後仍符合總長與單層上限', () => {
    settings.set('namingRule', '{title}/{post_id}.{ext}')
    const name = fileName.createFileName(
      result({ title: '錄'.repeat(300), fileName: 'a.png' })
    )
    expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
    const segments = name.split('/')
    expect(segments).toHaveLength(2)
    expect(segments[0].endsWith('…')).toBe(true)
    expect(segments[1]).toBe('999.png')
    for (const segment of segments) {
      expect(byteLength(segment)).toBeLessThanOrEqual(255)
    }
  })

  it('開頭點視為檔名而非副檔名（單層超長）', () => {
    const name = fileName.lengthLimit('.' + 'a'.repeat(300), '999')
    expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
  })

  it('單層超長檔名不產生負長度或破字', () => {
    settings.set('namingRule', '{title}.{ext}')
    const name = fileName.createFileName(result({ title: '😺'.repeat(200) }))
    expect(name.split('/')).toHaveLength(1)
    expect(byteLength(name)).toBeLessThanOrEqual(LIMIT)
    expect(name.endsWith('.png')).toBe(true)
    expect(name).toContain('999')
    expect(name).not.toContain('\uFFFD')
    expect(hasLoneSurrogate(name)).toBe(false)
  })
})
