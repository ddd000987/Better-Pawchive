/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Types shared by the locale files in src/locales/.
 * Adding a language: add src/locales/<code>.ts (copy en.ts, translate the
 * texts, fill in meta), then run `npm run locales` to regenerate the registry
 * (src/locales/index.ts). The file name is the language code. */

import type { texts as enTexts } from './locales/en'

/** i18n text key (starts with an underscore). en.ts defines the full set. */
export type LangTextKey = keyof typeof enTexts

/** Texts of a non-English locale; a missing key falls back to English */
export type LocaleTexts = Partial<Record<LangTextKey, string>>

export interface LocaleMeta {
  /** The language's name in itself, shown in the language menu */
  name: string
  /** BCP 47 tag for the `lang` attribute of the extension's own pages */
  htmlLang: string
  /** Browser language tags this locale serves, as lowercase BCP 47 patterns.
   * The first subtag must equal the tag's language and every other subtag
   * must appear somewhere in the tag: "zh" matches any Chinese tag, "zh-tw"
   * matches zh-TW and zh-Hant-TW. The pattern with the most subtags wins;
   * a tag no locale matches gets English. */
  match: readonly string[]
}
