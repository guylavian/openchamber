import { describe, expect, test } from 'bun:test';

import { agentTeamsI18n } from './agent-teams.i18n';

const placeholders = (text: string) => [...text.matchAll(/\{[a-z]+\}/g)].map((match) => match[0]).sort();

describe('agent teams strings', () => {
  const english: Record<string, string> = agentTeamsI18n.en;
  const keys = Object.keys(english).sort();

  for (const [locale, dict] of Object.entries(agentTeamsI18n)) {
    test(`${locale} has every key, translated, with the same placeholders`, () => {
      const entries: Array<[string, string]> = Object.entries(dict);
      expect(entries.map(([key]) => key).sort()).toEqual(keys);
      for (const [key, value] of entries) {
        expect(value.trim().length).toBeGreaterThan(0);
        expect(placeholders(value)).toEqual(placeholders(english[key]));
      }
      if (locale === 'en') return;
      // Loanwords (Frontend, Worktree, Model) may match English; a copied
      // dictionary would not.
      const identical = entries.filter(([key, value]) => value === english[key]).length;
      expect(identical / entries.length).toBeLessThan(0.1);
    });
  }
});
