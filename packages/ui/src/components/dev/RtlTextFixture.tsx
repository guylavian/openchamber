import React from 'react';
import type { Part } from '@/lib/opencode/model';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import UserTextPart from '@/components/chat/message/parts/UserTextPart';

/**
 * Development-only fixture for inspecting Hebrew/English bidi rendering.
 *
 * Reachable at `?rtlFixture=1` in a dev build (see `App.tsx`, which imports this
 * module behind `import.meta.env.DEV` so it is dropped from production bundles).
 *
 * Everything here goes through the real chat surfaces on purpose — the same
 * `MarkdownRenderer`, `SimpleMarkdownRenderer`, and `UserTextPart` the timeline
 * mounts — so what the fixture shows is what a session shows. A hand-written
 * HTML approximation would validate the wrong layer.
 *
 * Strings here are sample content, not UI copy, so they are intentionally not in
 * the i18n dictionaries: the whole surface is stripped from production builds.
 */

type AssistantCase = {
  id: string;
  title: string;
  note: string;
  content: string;
};

const ASSISTANT_CASES: AssistantCase[] = [
  {
    id: 'hebrew-only',
    title: 'Hebrew only',
    note: 'Expect: right-aligned, right-to-left. One block, one direction.',
    content: [
      'המשימה הסתיימה בהצלחה וכל הבדיקות עברו.',
      '',
      'השרת עלה, חיבור למסד הנתונים פעיל, והממשק זמין למשתמשים.',
    ].join('\n'),
  },
  {
    id: 'hebrew-english',
    title: 'Hebrew + English',
    note: 'Expect: RTL paragraph, English run kept in reading order inside it.',
    content: 'המשימה Backend API הסתיימה בהצלחה, והבדיקות עברו ב־OpenCode.',
  },
  {
    id: 'inline-code',
    title: 'Hebrew + inline code',
    note: 'Expect: code chip is an LTR island; parentheses keep their own order.',
    content: 'המשימה `Backend API` הסתיימה בהצלחה אחרי (after 30s) בדיוק.',
  },
  {
    id: 'file-paths',
    title: 'Hebrew + file paths',
    note: 'Expect: paths read left-to-right, including the ../ prefix, and hang in the marker gutter.',
    content: [
      'הקובץ נמצא ב־`/Users/guy/project/src/server.ts` וגם ב־`../shared/types.ts`.',
      '',
      'התיקון הוחל ב־`packages/ui/src/index.css` בשורה 41, לא ב־`docs/notes.md`.',
    ].join('\n'),
  },
  {
    id: 'bare-file-paths',
    title: 'Hebrew + bare file paths (file references on)',
    note: 'Expect: paths in backticks are isolated chips. A bare path that starts with a letter is fine; one that starts with punctuation (/ or ../) is the measured gap — see the report.',
    content: [
      'תיקנתי את הבאג ב־../shared/types.ts וב־packages/ui/src/index.css.',
      '',
      'ראה את ../shared/types.ts ואת /Users/guy/project/docs/notes.md לפרטים.',
    ].join('\n'),
  },
  {
    id: 'loose-list',
    title: 'Hebrew + loose list (wrapped items)',
    note: 'Expect: blank-line-separated items wrap in <p>; the list must still resolve RTL, not fall back to LTR.',
    content: [
      '1. בדוק את `Run #2` בלוג',
      '',
      '2. פתח את `Open session`',
      '',
      '3. הרץ `npm test` שוב',
    ].join('\n'),
  },
  {
    id: 'numbered-list',
    title: 'Hebrew + numbered list',
    note: 'Expect: markers on the right, numbers read correctly, items right-aligned.',
    content: [
      '1. בדוק את `Run #2`',
      '2. פתח את `Open session`',
      '3. הרץ `npm test`',
    ].join('\n'),
  },
  {
    id: 'bullets',
    title: 'Hebrew + bullets',
    note: 'Expect: bullets on the right; nesting indents inward on both sides.',
    content: [
      '- סיום המשימה `Backend API`',
      '- בדיקות חוזרות ל־`OpenCode`',
      '  - כולל `sessionId` חדש',
      '  - ללא `Task` שנכשלו',
    ].join('\n'),
  },
  {
    id: 'task-list',
    title: 'Hebrew + task list',
    note: 'Expect: the checkbox hangs in the marker gutter on the right, and the item text follows it.',
    content: [
      '- [x] סיום המשימה `Backend API`',
      '- [ ] הוספת בדיקה ל־`sessionId`',
    ].join('\n'),
  },
  {
    id: 'punctuation',
    title: 'Hebrew + parentheses and punctuation',
    note: 'Expect: brackets mirror around Hebrew, stay intact around English, terminal period on the left.',
    content: [
      'Task "Build" נכשל בגלל timeout (after 30s).',
      '',
      'הערה: הערך (מפתח) אישר; הבקשה (urgent) נשלחה ל־OpenCode.',
      '',
      'שאלה — האם להמשיך? כן/לא: לא.',
    ].join('\n'),
  },
  {
    id: 'code-block',
    title: 'Hebrew + code block',
    note: 'Expect: fence stays LTR with its gutter on the left, even inside a Hebrew block.',
    content: [
      'להלן הפקודה שהרצנו:',
      '',
      '```bash',
      '# בדיקה מהירה לפני commit',
      'bun run test --filter packages/ui',
      '```',
      '',
      'הפלט היה תקין.',
    ].join('\n'),
  },
  {
    id: 'technical-tokens',
    title: 'Hebrew + technical tokens',
    note: 'Expect: bare Latin tokens keep reading order; no stray movement around the punctuation.',
    content: [
      'ה־Run של Task ב־sessionId מסתיים תמיד ב־status succeeded.',
      '',
      'OpenCode קרא את config.toml ואת `opencode.json`, ואז שלח event ל־SSE.',
    ].join('\n'),
  },
  {
    id: 'english-first-then-hebrew',
    title: 'English block first, then Hebrew',
    note: 'Expect: each block takes its own direction — the English heading stays LTR, the Hebrew paragraph goes RTL.',
    content: [
      '## Build status',
      '',
      'הבנייה הסתיימה. כל 248 הבדיקות עברו.',
      '',
      '## הערות',
      '',
      'ה־bundle קטן ב־12% לעומת הגרסה הקודמת.',
    ].join('\n'),
  },
  {
    id: 'heading-quote-table',
    title: 'Hebrew headings, blockquote and table',
    note: 'Expect: quote bar on the right, table cells aligned by their own content.',
    content: [
      '## סיכום',
      '',
      '> המשימה הושלמה על ידי OpenCode בלי התערבות ידנית.',
      '',
      '| שדה | ערך |',
      '| --- | --- |',
      '| `status` | succeeded |',
      '| `duration` | 30s |',
    ].join('\n'),
  },
  {
    id: 'english-control',
    title: 'English-only control',
    note: 'Expect: unchanged from before this work. If this moves, the change is too broad.',
    content: [
      'The task `Backend API` finished successfully.',
      '',
      '1. Check `Run #2`',
      '2. Run `npm test`',
    ].join('\n'),
  },
];

const USER_CASES: Array<{ id: string; title: string; note: string; text: string }> = [
  {
    id: 'user-hebrew',
    title: 'User message, Hebrew only',
    note: 'Expect: the plain-text chat surface (no markdown) also aligns RTL.',
    text: 'תודה! זה עבד מצוין, בוא נמשיך לשלב הבא.',
  },
  {
    id: 'user-mixed',
    title: 'User message, Hebrew + English + path',
    note: 'Expect: RTL message with LTR path token, matching the assistant surface.',
    text: 'הקובץ נמצא ב־/Users/guy/project/src/server.ts, תודה!',
  },
  {
    id: 'user-english',
    title: 'User message, English control',
    note: 'Expect: unchanged.',
    text: 'Thanks, that worked. Let us continue.',
  },
];

const userPart = (index: number, text: string): Part => ({
  id: `rtl-fixture-user-${index}`,
  sessionID: 'rtl-fixture-session',
  messageID: 'rtl-fixture-message',
  type: 'text',
  text,
  time: { start: 0, end: 0 },
});

const assistantPart = (index: number, text: string): Part => ({
  id: `rtl-fixture-assistant-${index}`,
  sessionID: 'rtl-fixture-session',
  messageID: 'rtl-fixture-message',
  type: 'text',
  text,
  time: { start: 0, end: 0 },
});

const Section: React.FC<{ title: string; note: string; children: React.ReactNode }> = ({ title, note, children }) => (
  <section className="border-b border-border/60 px-6 py-5 last:border-b-0">
    <h2 className="font-mono text-[13px] font-medium text-muted-foreground">{title}</h2>
    <p className="mt-1 text-[13px] text-muted-foreground">{note}</p>
    <div className="mt-4">{children}</div>
  </section>
);

/** Chat-shaped column so line lengths match what a session actually uses. */
const Bubble: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-2xl border border-border/70 bg-surface-elevated px-4 py-3">{children}</div>
);

export const RtlTextFixture: React.FC = () => (
  <div className="h-full overflow-y-auto bg-background text-foreground" data-rtl-fixture="">
    <header className="sticky top-0 z-10 border-b border-border/70 bg-background/95 px-6 py-3 backdrop-blur">
      <h1 className="text-sm font-semibold">RTL / BiDi fixture</h1>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        Development only. Every case renders through the real chat surface. Reload without <code className="font-mono">?rtlFixture=1</code> to leave.
      </p>
    </header>

    <div className="mx-auto max-w-3xl">
      {USER_CASES.map((testCase, index) => (
        <Section key={testCase.id} title={`User message — ${testCase.title}`} note={testCase.note}>
          <div className="break-words font-sans typography-markdown-body text-base leading-relaxed text-foreground/90">
            <UserTextPart part={userPart(index, testCase.text)} messageId="rtl-fixture-message" isMobile={false} />
          </div>
        </Section>
      ))}

      {ASSISTANT_CASES.map((testCase, index) => (
        <Section key={testCase.id} title={`Assistant markdown — ${testCase.title}`} note={testCase.note}>
          <Bubble>
            <MarkdownRenderer
              content={testCase.content}
              // File references only engage for a part carrying real ids, so the
              // bare-path case below needs one to render its link spans.
              part={assistantPart(index, testCase.content)}
              messageId={`rtl-fixture-${testCase.id}`}
              isStreaming={false}
              isAnimated={false}
            />
          </Bubble>
        </Section>
      ))}
    </div>
  </div>
);
