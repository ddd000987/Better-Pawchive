import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOSTS,
  avatarUrl,
  bannerUrl,
  creatorPageUrl,
  makeCreatorKey,
  parseCreatorKey,
  postPageUrl,
  siteOfHost,
  thumbUrl,
} from '../src/watch/watchKey'

describe('watchKey', () => {
  it('siteOfHost identifies kemono and pawchive hosts and rejects others', () => {
    expect(siteOfHost('kemono.su')).toBe('kemono')
    expect(siteOfHost('sub.kemono.cr')).toBe('kemono')
    expect(siteOfHost('kemono.party')).toBe('kemono')
    expect(siteOfHost('pawchive.pw')).toBe('pawchive')
    expect(siteOfHost('www.pawchive.pw')).toBe('pawchive')
    expect(siteOfHost('KEMONO.CR:443')).toBe('kemono')
    expect(siteOfHost('WWW.PAWCHIVE.PW:8080')).toBe('pawchive')

    expect(siteOfHost('kemono.su.evil.com')).toBeNull()
    expect(siteOfHost('pawchive.pw.evil.com')).toBeNull()
    expect(siteOfHost('example.com')).toBeNull()
    expect(siteOfHost('')).toBeNull()
  })

  it('makeCreatorKey and parseCreatorKey round-trip valid keys', () => {
    const key = makeCreatorKey('pawchive', 'patreon', '12345')
    expect(key).toBe('pawchive/patreon/12345')
    expect(parseCreatorKey(key)).toEqual({
      site: 'pawchive',
      service: 'patreon',
      creatorId: '12345',
    })

    const kemonoKey = makeCreatorKey('kemono', 'fanbox', 'abc_99')
    expect(parseCreatorKey(kemonoKey)).toEqual({
      site: 'kemono',
      service: 'fanbox',
      creatorId: 'abc_99',
    })
  })

  it('makeCreatorKey throws on invalid parts and parseCreatorKey returns null', () => {
    expect(() => makeCreatorKey('other' as any, 'patreon', '1')).toThrow(
      'invalid creator key parts'
    )
    expect(() => makeCreatorKey('kemono', 'invalid' as any, '1')).toThrow(
      'invalid creator key parts'
    )
    expect(() => makeCreatorKey('kemono', 'patreon', '')).toThrow(
      'invalid creator key parts'
    )
    expect(() => makeCreatorKey('kemono', 'patreon', 'a/b')).toThrow(
      'invalid creator key parts'
    )

    expect(parseCreatorKey('')).toBeNull()
    expect(parseCreatorKey('kemono/patreon')).toBeNull()
    expect(parseCreatorKey('kemono/patreon/1/extra')).toBeNull()
    expect(parseCreatorKey('other/patreon/1')).toBeNull()
    expect(parseCreatorKey('kemono/unknown/1')).toBeNull()
    expect(parseCreatorKey('kemono/patreon/')).toBeNull()
  })

  it('builds page, avatar, banner, and thumbnail URLs', () => {
    expect(DEFAULT_HOSTS).toEqual({
      pawchive: 'pawchive.pw',
      kemono: 'kemono.cr',
    })
    expect(creatorPageUrl('kemono.cr', 'patreon', '42')).toBe(
      'https://kemono.cr/patreon/user/42'
    )
    expect(postPageUrl('pawchive.pw', 'fanbox', '42', '99')).toBe(
      'https://pawchive.pw/fanbox/user/42/post/99'
    )
    expect(avatarUrl('kemono.cr', 'patreon', '42')).toBe(
      'https://img.kemono.cr/icons/patreon/42'
    )
    expect(bannerUrl('pawchive.pw', 'fanbox', '42')).toBe(
      'https://pawchive.pw/banners/fanbox/42'
    )
    expect(thumbUrl('kemono.cr', '/ab/cd/pic.jpg')).toBe(
      'https://img.kemono.cr/thumbnail/data/ab/cd/pic.jpg'
    )
    expect(thumbUrl('kemono.cr', '')).toBe('')
  })
})
