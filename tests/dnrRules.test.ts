import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Rule {
  id: number
  condition: {
    urlFilter?: string
    requestDomains?: string[]
    initiatorDomains?: string[]
  }
  action: { responseHeaders?: unknown[] }
}

const read = (file: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'src', file), 'utf8'))

const rules = read('declarative_net_request_rules.json') as Rule[]

describe('declarative_net_request_rules.json', () => {
  it('keeps unique rule ids', () => {
    const ids = rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('anchors every host exactly (separator after the host, or requestDomains)', () => {
    for (const rule of rules) {
      const { urlFilter, requestDomains } = rule.condition
      if (requestDomains?.length) {
        continue
      }
      // "||kemono.su" alone would also match "kemono.su.evil.com"
      expect(urlFilter, `rule ${rule.id}`).toMatch(/^\|\|[a-z0-9.-]+\^/)
    }
  })

  it('limits the CORS response-header rules to the extension hosts', () => {
    const cors = rules.filter((r) => r.action.responseHeaders)
    expect(cors.length).toBeGreaterThan(0)
    for (const rule of cors) {
      expect(rule.condition.initiatorDomains, `rule ${rule.id}`).toEqual(
        expect.arrayContaining(['kemono.cr', 'pawchive.pw'])
      )
    }
  })

  it('has no rules for hosts that are gone', () => {
    // kemono.su / kemono.party no longer resolve; n1–n4 and file.kemono.cr
    // were Kemono's original-file servers
    const gone = /kemono\.(su|party)|(^|\|)(n\d|file)\.kemono\.cr/
    for (const rule of rules) {
      const { urlFilter = '', initiatorDomains = [] } = rule.condition
      expect(urlFilter, `rule ${rule.id}`).not.toMatch(gone)
      expect(initiatorDomains.join(' '), `rule ${rule.id}`).not.toMatch(gone)
    }
  })
})

describe('manifest.json', () => {
  it('serves the injected history hook through a dynamic URL', () => {
    const manifest = read('manifest.json')
    const entry = manifest.web_accessible_resources.find(
      (e: { resources: string[] }) =>
        e.resources.includes('lib/listen_history_change.js')
    )
    expect(entry.use_dynamic_url).toBe(true)
  })
})
