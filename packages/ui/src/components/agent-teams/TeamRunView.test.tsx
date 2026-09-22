import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { TeamAgent, TeamRun, TeamRunMember } from '@/lib/agent-teams/api';
import { I18nProvider } from '@/lib/i18n';
import { TeamRunView } from './TeamRunView';

const agent = (id: string, name: string, edits = true): TeamAgent => ({ id, name, role: id, instructions: '', model: null, agent: null, edits });

const member = (agentId: string, stageIndex: number, extra: Partial<TeamRunMember> = {}): TeamRunMember => ({
  agentId, stageIndex, attempt: 1, status: 'pending', sessionId: null, directory: null, worktree: null, model: null,
  startedAt: null, finishedAt: null, output: null, changes: null, error: null, ...extra,
});

const baseRun = (members: TeamRunMember[], extra: Partial<TeamRun> = {}): TeamRun => ({
  id: 'run-1', teamId: 'team-1', teamName: 'Feature Development', goal: 'Add OAuth login', directory: '/repo', workspace: 'isolated',
  team: {
    agents: [agent('planner', 'Planner', false), agent('backend', 'Backend'), agent('reviewer', 'Reviewer', false)],
    stages: [
      { id: 's1', agentIds: ['planner'], mode: 'sequential' },
      { id: 's2', agentIds: ['backend'], mode: 'sequential' },
      { id: 's3', agentIds: ['reviewer'], mode: 'sequential' },
    ],
  },
  status: 'running', error: null, createdAt: 1_000, updatedAt: 2_000, finishedAt: null,
  members,
  timeline: [{ at: 1_000, kind: 'run-started', memberId: null, message: null }],
  ...extra,
});

let windowInstance: Window;
let host: HTMLElement;
let root: Root;
const saved = { ...globalThis };

beforeEach(() => {
  windowInstance = new Window({ url: 'http://localhost/' });
  // SAFETY: the test installs a happy-dom Window for the component and restores the original globals afterward.
  Object.assign(globalThis, {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    Node: windowInstance.Node,
    Element: windowInstance.Element,
    HTMLElement: windowInstance.HTMLElement,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    MutationObserver: windowInstance.MutationObserver,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await windowInstance.happyDOM.abort();
  windowInstance.close();
  Object.assign(globalThis, {
    window: saved.window,
    document: saved.document,
    navigator: saved.navigator,
    IS_REACT_ACT_ENVIRONMENT: undefined,
  });
});

type Calls = { opened: Array<[string, string | null]>; cancelled: number; retriedMembers: string[]; retriedStages: number[] };

const render = async (run: TeamRun, calls: Calls) => {
  await act(async () => {
    root.render(
      <I18nProvider>
        <TeamRunView
          run={run}
          now={121_000}
          busy={false}
          onOpenSession={(sessionId, directory) => calls.opened.push([sessionId, directory])}
          onCancel={() => { calls.cancelled += 1; }}
          onRetryMember={(agentId) => calls.retriedMembers.push(agentId)}
          onRetryStage={(stageIndex) => calls.retriedStages.push(stageIndex)}
        />
      </I18nProvider>,
    );
  });
};

const newCalls = (): Calls => ({ opened: [], cancelled: 0, retriedMembers: [], retriedStages: [] });
const statusOf = (agentId: string) => host.querySelector(`[data-member="${agentId}"] [data-status]`)?.getAttribute('data-status');
const buttonWithText = (scope: Element, text: string) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.includes(text));

describe('TeamRunView', () => {
  test('shows each member\'s live status as the run moves on', async () => {
    const calls = newCalls();
    await render(baseRun([
      member('planner', 0, { status: 'running', sessionId: 'ses-1', directory: '/repo', startedAt: 1_000 }),
      member('backend', 1),
      member('reviewer', 2),
    ]), calls);
    expect(statusOf('planner')).toBe('running');
    expect(statusOf('backend')).toBe('pending');
    expect(host.textContent).toContain('Waiting');
    expect(host.textContent).toContain('2m 0s');

    await render(baseRun([
      member('planner', 0, { status: 'completed', sessionId: 'ses-1', directory: '/repo', startedAt: 1_000, finishedAt: 31_000, output: 'The plan' }),
      member('backend', 1, { status: 'running', sessionId: 'ses-2', directory: '/wt/backend', startedAt: 31_000, worktree: { path: '/wt/backend', branch: 'team/r-backend-1' } }),
      member('reviewer', 2),
    ]), calls);
    expect(statusOf('planner')).toBe('completed');
    expect(statusOf('backend')).toBe('running');
    expect(host.querySelector('[data-member="backend"]')?.textContent).toContain('team/r-backend-1');
    // No summary while the run is still going.
    expect(host.querySelector('[data-testid="team-run-summary"]')).toBeNull();
  });

  test('opens a member\'s own session when asked', async () => {
    const calls = newCalls();
    await render(baseRun([
      member('planner', 0, { status: 'running', sessionId: 'ses-1', directory: '/repo', startedAt: 1_000 }),
      member('backend', 1),
      member('reviewer', 2),
    ]), calls);
    const planner = host.querySelector('[data-member="planner"]');
    const open = planner && buttonWithText(planner, 'Open session');
    await act(async () => open?.click());
    expect(calls.opened).toEqual([['ses-1', '/repo']]);
    // A member that has not started has no session to open.
    expect(buttonWithText(host.querySelector('[data-member="backend"]')!, 'Open session')).toBeUndefined();

    const cancel = buttonWithText(host, 'Cancel run');
    await act(async () => cancel?.click());
    expect(calls.cancelled).toBe(1);
  });

  test('makes a failure visible and offers retry', async () => {
    const calls = newCalls();
    await render(baseRun([
      member('planner', 0, { status: 'completed', sessionId: 'ses-1', startedAt: 1_000, finishedAt: 2_000, output: 'Plan' }),
      member('backend', 1, { status: 'failed', sessionId: 'ses-2', startedAt: 2_000, finishedAt: 3_000, error: 'Rate limit reached' }),
      member('reviewer', 2),
    ], { status: 'failed', finishedAt: 3_000 }), calls);

    const alerts = [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts.some((text) => text?.includes('Backend'))).toBe(true);
    expect(alerts).toContain('Rate limit reached');
    expect(buttonWithText(host, 'Cancel run')).toBeUndefined();

    const backend = host.querySelector('[data-member="backend"]')!;
    await act(async () => buttonWithText(backend, 'Retry')?.click());
    expect(calls.retriedMembers).toEqual(['backend']);
    // The reviewer's stage cannot be retried while the stage before it failed.
    expect(host.querySelectorAll('section[aria-label^="Stage"] button').length).toBeGreaterThan(0);
    const reviewerStage = host.querySelector('section[aria-label="Stage 3"]')!;
    expect(buttonWithText(reviewerStage, 'Retry stage')).toBeUndefined();
  });

  test('summarizes a completed run above the individual results', async () => {
    const calls = newCalls();
    await render(baseRun([
      member('planner', 0, { status: 'completed', sessionId: 'ses-1', startedAt: 1, finishedAt: 2, output: '## Implementation plan\n1. Routes' }),
      member('backend', 1, { status: 'completed', sessionId: 'ses-2', startedAt: 2, finishedAt: 3, output: 'Added OAuth endpoints.' }),
      member('reviewer', 2, { status: 'completed', sessionId: 'ses-3', startedAt: 3, finishedAt: 4, output: 'Found one issue.' }),
    ], { status: 'completed', finishedAt: 4, timeline: [
      { at: 1, kind: 'run-started', memberId: null, message: null },
      { at: 2, kind: 'member-completed', memberId: 'planner', message: null },
      { at: 4, kind: 'run-completed', memberId: null, message: null },
    ] }), calls);

    const summary = host.querySelector('[data-testid="team-run-summary"]');
    expect(summary?.textContent).toContain('Team run complete');
    expect(summary?.textContent).toContain('Implementation plan');
    expect(summary?.textContent).toContain('Added OAuth endpoints.');
    // Every member's own card is still there.
    expect(host.querySelectorAll('[data-member]').length).toBe(3);
    expect(host.textContent).toContain('Planner completed');
    expect(host.textContent).toContain('Run completed');
  });
});
