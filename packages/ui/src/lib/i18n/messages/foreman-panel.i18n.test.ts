import { describe, expect, test } from 'bun:test';
import { foremanPanelI18n } from './foreman-panel.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const english: Record<string, string> = foremanPanelI18n.en;
const requiredKeys = Object.keys(english);

// "Session" is the same word in French.
const matchingEnglishAllowed = new Set<string>(['foreman.jobs.run.session']);

describe('foreman panel translations', () => {
  test('provides every required key in every supported locale, translated', () => {
    expect(requiredKeys.length).toBeGreaterThan(30);
    for (const locale of locales) {
      const dictionary: Record<string, string> = foremanPanelI18n[locale];
      expect(Object.keys(dictionary).sort()).toEqual([...requiredKeys].sort());
      for (const key of requiredKeys) {
        const value = dictionary[key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !matchingEnglishAllowed.has(key)) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });

  test('placeholders survive translation', () => {
    for (const locale of locales) {
      const dictionary: Record<string, string> = foremanPanelI18n[locale];
      expect(dictionary['foreman.jobs.run.label']).toContain('{number}');
      expect(dictionary['foreman.jobs.run.session']).toContain('{id}');
      expect(dictionary['foreman.jobs.error.load']).toContain('{message}');
      expect(dictionary['foreman.jobs.error.save']).toContain('{message}');
    }
  });
});
