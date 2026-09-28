/**
 * The Foreman Jobs surface is an ordinary workspace surface: placed, moved and
 * hidden by the zone model like Git or Terminal, and nothing the layout does
 * reaches Foreman's data.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import type { ForemanApi } from '@/lib/foreman/api';
import type { ForemanState } from '@/lib/foreman/model';
import { CONTEXT_SURFACES, getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';
import { createDefaultWorkspaceLayout, mainChatZone, zoneOfSurface, type WorkspaceZone } from '@/lib/workspace/layout';
import { createForemanStore } from '@/stores/useForemanStore';
import { selectVisibleContextZoneTab, useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { isWorkspaceZoneVisible, occupiedZones } from './useWorkspaceZones';

const directory = '/repo';

const shownMode = (zone: WorkspaceZone): string | null => {
  const state = useUIStore.getState();
  const view = {
    directoryKey: directory,
    layout: state.workspaceLayout,
    panel: state.contextPanelByDirectory[directory],
    occupied: occupiedZones(state.workspaceLayout, state.contextPanelByDirectory[directory]),
  };
  if (!isWorkspaceZoneVisible(view, zone)) return null;
  const tab = selectVisibleContextZoneTab(state, directory, zone);
  if (tab) return tab.mode;
  return mainChatZone(state.workspaceLayout) === zone ? 'main-chat' : null;
};

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextRailOrder: [],
    workspaceLayout: createDefaultWorkspaceLayout(),
  });
  useTerminalStore.getState().clearAll();
});

describe('Jobs in the surface registry', () => {
  test('is registered like any built-in surface and placed by the layout', () => {
    const jobs = CONTEXT_SURFACES.find((surface) => surface.id === 'jobs');
    expect(jobs).toMatchObject({ mode: 'jobs', availability: 'always' });
    expect(zoneOfSurface(createDefaultWorkspaceLayout(), 'jobs')).toBe('right');
  });

  test('is on the rail everywhere but VS Code, which has no Foreman server', () => {
    const base = {
      railOrder: [],
      tabs: [],
      planModeEnabled: false,
      linearConnected: false,
      githubConnected: false,
      screenWidth: 1600,
    };
    expect(getVisibleContextRailSurfaces({ ...base, isVSCode: false }).some((surface) => surface.id === 'jobs')).toBe(true);
    expect(getVisibleContextRailSurfaces({ ...base, isVSCode: true }).some((surface) => surface.id === 'jobs')).toBe(false);
  });

  test('opens in its zone beside the conversation', () => {
    useUIStore.getState().openContextSurface(directory, 'jobs');
    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('right')).toBe('jobs');
  });

  test('moves to another zone and stays on screen there', () => {
    useUIStore.getState().openContextSurface(directory, 'jobs');
    useUIStore.getState().moveWorkspaceSurface('jobs', 'left');
    expect(zoneOfSurface(useUIStore.getState().workspaceLayout, 'jobs')).toBe('left');
    expect(shownMode('left')).toBe('jobs');
    expect(shownMode('right')).toBeNull();
  });

  test('Jobs left, conversation center, Git right and Terminal bottom coexist', () => {
    const ui = useUIStore.getState();
    ui.moveWorkspaceSurface('jobs', 'left');
    ui.moveWorkspaceSurface('terminal', 'bottom');
    ui.openContextSurface(directory, 'jobs');
    ui.openContextSurface(directory, 'git');
    ui.openContextSurface(directory, 'terminal');
    expect(shownMode('left')).toBe('jobs');
    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('right')).toBe('git');
    expect(shownMode('bottom')).toBe('terminal');
  });
});

describe('layout never touches Foreman data', () => {
  test('moving, hiding and reopening Jobs makes no Foreman request and leaves its state as it was', async () => {
    const state: ForemanState = {
      version: 2,
      globalConcurrency: 3,
      jobs: [{ id: 'j1', title: 'Job', status: 'running', directory, maxParallelTasks: 3, createdAt: 1, updatedAt: 1 }],
      tasks: [{ id: 't1', jobId: 'j1', title: 'Task', status: 'running', dependsOn: [], createdAt: 1, updatedAt: 1 }],
      runs: [{
        id: 'r1', taskId: 't1', status: 'running', startedAt: 2,
        execution: { type: 'opencode-session', id: 'ses_1', directory, createdAt: 2 },
        createdAt: 2, updatedAt: 2,
      }],
    };
    const calls: string[] = [];
    const record = <T>(name: string, value: T): Promise<T> => {
      calls.push(name);
      return Promise.resolve(value);
    };
    const api: ForemanApi = {
      fetchState: () => record('fetchState', structuredClone(state)),
      createJob: () => record('createJob', state.jobs[0]),
      updateJob: () => record('updateJob', state.jobs[0]),
      createTask: () => record('createTask', state.tasks[0]),
      updateTask: () => record('updateTask', state.tasks[0]),
      createRun: () => record('createRun', state.runs[0]),
      updateRun: () => record('updateRun', state.runs[0]),
      startRun: () => record('startRun', { run: state.runs[0], alreadyStarted: true }),
      stopRun: () => record('stopRun', { run: state.runs[0], stopped: false }),
      listMemories: () => record('listMemories', []),
      listRunActivity: () => record('listRunActivity', []),
      addRunActivity: (_runId, input) => record('addRunActivity', { id: 'activity-1', runId: _runId, ...input, timestamp: 1 }),
      createMemory: () => record('createMemory', { id: 'm1', scope: 'workspace', workspaceId: directory, type: 'fact', content: 'x', tags: [], source: 'user', confidence: 0.8, createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 }),
      updateMemory: () => record('updateMemory', { id: 'm1', scope: 'workspace', workspaceId: directory, type: 'fact', content: 'x', tags: [], source: 'user', confidence: 0.8, createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 }),
      deleteMemory: () => record('deleteMemory', { id: 'm1', scope: 'workspace', workspaceId: directory, type: 'fact', content: 'x', tags: [], source: 'user', confidence: 0.8, createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 }),
    };
    const foreman = createForemanStore(api);
    await foreman.getState().load();
    const before = structuredClone({ jobs: foreman.getState().jobs, tasks: foreman.getState().tasks, runs: foreman.getState().runs });

    const ui = useUIStore.getState();
    ui.openContextSurface(directory, 'jobs');
    ui.moveWorkspaceSurface('jobs', 'left');
    ui.moveWorkspaceSurface('jobs', 'bottom');
    const jobsTab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((tab) => tab.mode === 'jobs');
    if (jobsTab) ui.closeContextPanelTab(directory, jobsTab.id);
    ui.openContextSurface(directory, 'jobs');
    ui.resetWorkspaceLayout();

    expect(calls).toEqual(['fetchState']);
    expect({ jobs: foreman.getState().jobs, tasks: foreman.getState().tasks, runs: foreman.getState().runs }).toEqual(before);
    // Nothing about the layout stopped, restarted or touched the running run.
    expect(foreman.getState().runs[0]).toMatchObject({ status: 'running', execution: { id: 'ses_1' } });
    expect(foreman.getState().runs[0].stoppedAt).toBeUndefined();
  });
});
