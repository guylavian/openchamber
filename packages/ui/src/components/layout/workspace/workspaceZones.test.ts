/**
 * What the workspace actually puts on screen.
 *
 * These drive the real store and then ask the same two functions the layout
 * components ask — `isWorkspaceZoneVisible` for whether a zone is drawn at all,
 * and `activeContextTabForZone` for which surface it shows — so a regression in
 * either decision fails here rather than only in the browser.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { selectContextZoneTab, selectVisibleContextZoneTab } from '@/stores/useUIStore';
import {
  createDefaultWorkspaceLayout,
  detachedSurfaceIdsFor,
  mainChatZone,
  type WorkspaceLayout,
  type WorkspaceZone,
} from '@/lib/workspace/layout';
import { isWorkspaceZoneVisible, occupiedZones, type WorkspaceZonesView } from './useWorkspaceZones';

const directory = '/repo';

const view = (): WorkspaceZonesView => {
  const state = useUIStore.getState();
  const layout: WorkspaceLayout = state.workspaceLayout;
  const panel = state.contextPanelByDirectory[directory];
  const occupied = occupiedZones(layout, panel?.tabs ?? [], detachedSurfaceIdsFor(state.detachedSurfaces, directory));
  return { directoryKey: directory, layout, panel, occupied };
};

const visibleZones = (): WorkspaceZone[] => {
  const current = view();
  return (['left', 'center', 'right', 'bottom'] as const).filter((zone) => isWorkspaceZoneVisible(current, zone));
};

/** The surface a zone shows right now, or null when the zone draws nothing. */
const shownMode = (zone: WorkspaceZone): string | null => {
  const state = useUIStore.getState();
  if (!isWorkspaceZoneVisible(view(), zone)) return null;
  const tab = selectVisibleContextZoneTab(state, directory, zone);
  if (tab) return tab.mode;
  // The chat's zone resolves to no tab precisely when the conversation is what
  // it is showing.
  return mainChatZone(state.workspaceLayout) === zone ? 'main-chat' : null;
};

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextRailOrder: [],
    workspaceLayout: createDefaultWorkspaceLayout(),
    detachedSurfaces: [],
  });
  useTerminalStore.getState().clearAll();
});

describe('default layout', () => {
  test('draws the conversation in the center and nothing else', () => {
    expect(visibleZones()).toEqual(['center']);
    expect(shownMode('center')).toBe('main-chat');
  });

  test('an empty zone is not drawn, so it consumes no space', () => {
    expect(isWorkspaceZoneVisible(view(), 'left')).toBe(false);
    expect(isWorkspaceZoneVisible(view(), 'bottom')).toBe(false);
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });

  test('opening a surface reveals its zone beside the conversation', () => {
    useUIStore.getState().openContextSurface(directory, 'git');

    expect(visibleZones()).toEqual(['center', 'right']);
    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('right')).toBe('git');
  });
});

describe('several zones at once', () => {
  test('files left, conversation center and terminal bottom coexist', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('editor', 'left');
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'file');
    store.openContextSurface(directory, 'terminal');

    expect(visibleZones()).toEqual(['left', 'center', 'bottom']);
    expect(shownMode('left')).toBe('file');
    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('bottom')).toBe('terminal');
  });

  test('a bottom terminal coexists with the center conversation', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('center')).toBe('main-chat');
  });

  test('activating git does not hide a surface in another zone', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('right')).toBe('git');
    expect(shownMode('center')).toBe('main-chat');
  });

  test('two surfaces in one zone are tabs: activating one replaces the other there only', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.moveWorkspaceSurface('git', 'bottom');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');

    expect(shownMode('bottom')).toBe('git');
    expect(visibleZones()).toEqual(['center', 'bottom']);

    useUIStore.getState().openContextSurface(directory, 'terminal');
    expect(shownMode('bottom')).toBe('terminal');
  });
});

describe('moving from a menu', () => {
  // The bug report: "Move to bottom" on a surface that had never been opened
  // changed nothing on screen until its rail icon was clicked again.
  test('moving a surface that was never opened shows it in its new zone', () => {
    useUIStore.getState().moveWorkspaceSurface('terminal', 'bottom', { revealIn: directory });

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('center')).toBe('main-chat');
  });

  test('moving a surface that is already showing keeps it on screen in the new zone', () => {
    useUIStore.getState().openContextSurface(directory, 'git');
    useUIStore.getState().moveWorkspaceSurface('git', 'bottom', { revealIn: directory });

    expect(shownMode('bottom')).toBe('git');
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });

  test('moving a collapsed surface brings its zone back', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.closeContextZone(directory, 'right');
    useUIStore.getState().moveWorkspaceSurface('git', 'left', { revealIn: directory });

    expect(shownMode('left')).toBe('git');
  });

  test('moving the chat brings it in front of a tab already in that zone', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    useUIStore.getState().moveWorkspaceSurface('chat', 'right', { revealIn: directory });

    expect(shownMode('right')).toBe('main-chat');
  });

  test('a layout-only move without a directory does not open anything', () => {
    useUIStore.getState().moveWorkspaceSurface('terminal', 'bottom');

    expect(isWorkspaceZoneVisible(view(), 'bottom')).toBe(false);
  });
});

describe('a surface in its own window', () => {
  test('is not drawn here, and its zone closes if nothing else is in it', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'terminal');
    expect(shownMode('right')).toBe('terminal');

    useUIStore.getState().setSurfaceDetached(directory, 'terminal', true);
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
    // The tab itself is kept, so closing the window can put it back.
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'terminal')).toBe(true);
  });

  test('leaves the other surfaces in its zone where they are', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextSurface(directory, 'terminal');
    useUIStore.getState().setSurfaceDetached(directory, 'terminal', true);

    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(true);
  });

  test('comes back to its zone when its window closes', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'terminal');
    store.setSurfaceDetached(directory, 'terminal', true);
    useUIStore.getState().setSurfaceDetached(directory, 'terminal', false);

    expect(shownMode('right')).toBe('terminal');
  });

  test('is detached for its own project only', () => {
    const other = '/other';
    useUIStore.getState().openContextSurface(other, 'terminal');
    useUIStore.getState().setSurfaceDetached(directory, 'terminal', true);

    const state = useUIStore.getState();
    expect(detachedSurfaceIdsFor(state.detachedSurfaces, other)).toEqual([]);
    expect(selectVisibleContextZoneTab(state, other, 'right')?.mode).toBe('terminal');
  });

  test('is not remembered across a restart', () => {
    useUIStore.getState().setSurfaceDetached(directory, 'terminal', true);
    const persisted = JSON.stringify(useUIStore.persist.getOptions().partialize?.(useUIStore.getState()));

    expect(Object.keys(JSON.parse(persisted))).not.toContain('detachedSurfaces');
  });
});

describe('moving the conversation', () => {
  test('moving chat to the right draws it there and frees the center', () => {
    useUIStore.getState().moveWorkspaceSurface('chat', 'right');

    expect(visibleZones()).toEqual(['right']);
    expect(shownMode('right')).toBe('main-chat');
  });

  test('the conversation keeps its zone open even when nothing else is docked there', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('chat', 'right');
    store.closeContextZone(directory, 'right');

    // Collapsing must never leave the user without the session they are in.
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(true);
  });

  test('a surface sharing the conversation zone can be brought forward and dismissed', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('chat', 'right');
    store.openContextSurface(directory, 'git');

    expect(shownMode('right')).toBe('git');

    useUIStore.getState().focusMainChat(directory);
    expect(shownMode('right')).toBe('main-chat');
    // The git tab is still there, just behind the conversation.
    expect(selectContextZoneTab(useUIStore.getState(), directory, 'right')).toBe(null);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'git')).toBe(true);
  });
});

describe('per-zone selection', () => {
  test('a split session opens beside the conversation, not over it', () => {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'chat', dedupeKey: 'session:other' });

    expect(shownMode('center')).toBe('main-chat');
    expect(shownMode('right')).toBe('chat');
  });

  test('working in another zone keeps the conversation in front of its own', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('chat', 'right');
    store.openContextSurface(directory, 'git');
    useUIStore.getState().focusMainChat(directory);
    useUIStore.getState().moveWorkspaceSurface('terminal', 'bottom');
    useUIStore.getState().openContextSurface(directory, 'terminal');

    expect(shownMode('right')).toBe('main-chat');
    expect(shownMode('bottom')).toBe('terminal');
  });

  test('closing the tab a zone shows falls back to another tab in that zone', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.openContextSurface(directory, 'terminal');
    const terminalTab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((tab) => tab.mode === 'terminal');
    useUIStore.getState().closeContextPanelTab(directory, terminalTab?.id ?? '');

    expect(shownMode('right')).toBe('git');
  });
});

describe('presets', () => {
  test('a surface on screen stays on screen in its new zone', () => {
    useUIStore.getState().openContextSurface(directory, 'terminal');
    useUIStore.getState().applyWorkspaceLayoutPreset('developer');

    expect(shownMode('bottom')).toBe('terminal');
  });

  test('reset brings a moved surface back on screen', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    useUIStore.getState().resetWorkspaceLayout();

    expect(shownMode('right')).toBe('terminal');
  });
});

describe('collapsing a zone', () => {
  test('a collapsed zone is not drawn but keeps its tabs for reopening', () => {
    const store = useUIStore.getState();
    store.openContextSurface(directory, 'git');
    store.closeContextZone(directory, 'right');

    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'git')).toBe(true);

    useUIStore.getState().openContextZone(directory, 'right');
    expect(shownMode('right')).toBe('git');
  });

  test('collapsing one zone leaves the others alone', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.openContextSurface(directory, 'terminal');
    store.openContextSurface(directory, 'git');
    store.closeContextZone(directory, 'right');

    expect(shownMode('bottom')).toBe('terminal');
    expect(shownMode('center')).toBe('main-chat');
    expect(isWorkspaceZoneVisible(view(), 'right')).toBe(false);
  });
});

describe('persistence', () => {
  test('zone assignment, sizes and open zones survive a round trip', () => {
    const store = useUIStore.getState();
    store.moveWorkspaceSurface('terminal', 'bottom');
    store.setWorkspaceZoneSize('bottom', 320);
    store.setWorkspaceZoneSize('left', 300);
    store.openContextSurface(directory, 'terminal');

    const snapshot = JSON.parse(JSON.stringify({
      workspaceLayout: useUIStore.getState().workspaceLayout,
      workspaceZoneSizes: useUIStore.getState().workspaceZoneSizes,
      openZones: useUIStore.getState().contextPanelByDirectory[directory]?.openZones,
    }));

    expect(snapshot.workspaceLayout.bottom).toContain('terminal');
    expect(snapshot.workspaceZoneSizes).toEqual({ left: 300, right: 420, bottom: 320 });
    expect(snapshot.openZones).toEqual(['bottom']);
  });

  test('a zone size never drops below its usable minimum', () => {
    useUIStore.getState().setWorkspaceZoneSize('bottom', 10);
    expect(useUIStore.getState().workspaceZoneSizes.bottom).toBe(160);

    useUIStore.getState().setWorkspaceZoneSize('left', 10);
    expect(useUIStore.getState().workspaceZoneSizes.left).toBe(240);
  });
});
