import React from 'react';

import { isContextPanelMode } from '@/lib/surfaces/modes';
import { detachedSurfaceIdsFor } from '@/lib/workspace/layout';
import { modeForSurface, openSurfaceWindow, openSurfaceWindowChannel } from '@/lib/workspace/surfaceWindow';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/**
 * A detached window says it is alive this often. `pagehide` announces a close
 * immediately when it fires, but it does not fire when a window crashes or is
 * killed, so liveness is what finally decides: a surface whose window has gone
 * quiet comes back rather than staying hidden with nowhere to be seen.
 */
const HEARTBEAT_MS = 2000;
/**
 * Generous on purpose. Browsers throttle timers in background windows (Chrome
 * down to one wake-up a minute), so a window the user simply is not looking
 * at can go quiet for a long while and must not be taken for dead. A web
 * popup's `closed` flag and `pagehide` catch ordinary closes long before this.
 */
const SILENCE_LIMIT_MS = 3 * 60 * 1000;
/** A new window has to boot the whole app before its first heartbeat. */
const OPEN_GRACE_MS = 20000;

const windowKey = (directory: string, surfaceId: string) => `${directory}\n${surfaceId}`;

/** When each detached window was last heard from (main window side). */
const lastHeardAt = new Map<string, number>();
/** Web popups this window opened, watched so a close is noticed at once. */
const popups = new Map<string, Window>();

const markHeard = (directory: string, surfaceId: string, at: number) => {
  lastHeardAt.set(windowKey(directory, surfaceId), at);
};

const reattach = (directory: string, surfaceId: string) => {
  const key = windowKey(directory, surfaceId);
  lastHeardAt.delete(key);
  popups.delete(key);
  useUIStore.getState().setSurfaceDetached(directory, surfaceId, false);
};

/**
 * Main-window side: keeps `detachedSurfaces` in step with the surface windows
 * that are actually open, and forwards to a detached window whatever the main
 * window opens for its surface (a file link, a diff), since the main window
 * no longer draws it. On mount it asks every open surface window to announce
 * itself, so a reloaded main window does not draw a surface that is still
 * living in another window.
 */
export const useSurfaceWindowSync = (): void => {
  React.useEffect(() => {
    const channel = openSurfaceWindowChannel((message) => {
      const { setSurfaceDetached } = useUIStore.getState();
      if (message.type === 'opened') {
        markHeard(message.directory, message.surfaceId, Date.now());
        setSurfaceDetached(message.directory, message.surfaceId, true);
      }
      if (message.type === 'closed') reattach(message.directory, message.surfaceId);
    });
    channel?.post({ type: 'roll-call' });

    const sweep = window.setInterval(() => {
      const now = Date.now();
      for (const { directory, surfaceId } of useUIStore.getState().detachedSurfaces) {
        const key = windowKey(directory, surfaceId);
        const silentFor = now - (lastHeardAt.get(key) ?? 0);
        if (popups.get(key)?.closed || silentFor > SILENCE_LIMIT_MS) reattach(directory, surfaceId);
      }
    }, HEARTBEAT_MS);

    // Forwarding. A tab counts as newly revealed when the active tab changes
    // or is touched again (re-opening the same file). The pending editor
    // navigation is set right after the tab opens, in the same call, so the
    // message is sent once that call has finished.
    const lastRevealed = new Map<string, string>();
    const unsubscribe = useUIStore.subscribe((state) => {
      for (const [directory, panel] of Object.entries(state.contextPanelByDirectory)) {
        const tab = panel.tabs.find((entry) => entry.id === panel.activeTabId);
        const marker = tab ? `${tab.id}:${tab.touchedAt}` : '';
        if (lastRevealed.get(directory) === marker) continue;
        lastRevealed.set(directory, marker);
        if (!tab) continue;
        const surfaceId = detachedSurfaceIdsFor(state.detachedSurfaces, directory)
          .find((id) => modeForSurface(id) === tab.mode);
        if (!surfaceId) continue;
        queueMicrotask(() => {
          const { pendingFileNavigation, setPendingFileNavigation } = useUIStore.getState();
          const fileNavigation = pendingFileNavigation?.path === tab.targetPath ? pendingFileNavigation : null;
          channel?.post({
            type: 'reveal',
            surfaceId,
            directory,
            tab: {
              mode: tab.mode,
              targetPath: tab.targetPath,
              targetDirectory: tab.targetDirectory,
              dedupeKey: tab.dedupeKey,
              label: tab.label,
              sessionTitleFallback: tab.sessionTitleFallback,
              readOnly: tab.readOnly,
              stagedDiff: tab.stagedDiff,
              diffScope: tab.diffScope,
            },
            fileNavigation,
          });
          // Delivered elsewhere; left here it would fire when the surface
          // comes back.
          if (fileNavigation) setPendingFileNavigation(null);
        });
      }
    });

    return () => {
      unsubscribe();
      window.clearInterval(sweep);
      channel?.close();
    };
  }, []);
};

/** Brings a detached surface's window to the front. */
export const focusSurfaceWindow = (directory: string, surfaceId: string): void => {
  const channel = openSurfaceWindowChannel(() => undefined);
  channel?.post({ type: 'focus', surfaceId, directory: normalizeContextPanelDirectoryKey(directory) });
  channel?.close();
};

/**
 * Opens a surface in its own window and hides it here. The surface is hidden
 * first so it never shows in two places; if the runtime refuses the window (a
 * blocked popup), it is put straight back rather than vanishing, and if the
 * window never reports in, the liveness sweep puts it back after the grace.
 */
export const detachSurface = async (surfaceId: string, rawDirectory: string): Promise<void> => {
  const directory = normalizeContextPanelDirectoryKey(rawDirectory);
  if (!directory) return;
  markHeard(directory, surfaceId, Date.now() + OPEN_GRACE_MS - SILENCE_LIMIT_MS);
  useUIStore.getState().setSurfaceDetached(directory, surfaceId, true);
  const result = await openSurfaceWindow({ surfaceId, directory });
  if (result.status === 'refused') {
    reattach(directory, surfaceId);
    return;
  }
  if (result.popup) popups.set(windowKey(directory, surfaceId), result.popup);
};

/**
 * Detached-window side: announces this window on a heartbeat while it is
 * open, answers a main window's roll-call, opens what the main window
 * forwards, comes forward when asked, and says goodbye on `pagehide` when the
 * browser gives it the chance.
 */
export const useSurfaceWindowPresence = (surfaceId: string, rawDirectory: string): void => {
  React.useEffect(() => {
    const directory = normalizeContextPanelDirectoryKey(rawDirectory);
    const surfaceMode = modeForSurface(surfaceId);
    const isMine = (message: { surfaceId: string; directory: string }) =>
      message.surfaceId === surfaceId && message.directory === directory;

    const channel = openSurfaceWindowChannel((message) => {
      if (message.type === 'roll-call') channel?.post({ type: 'opened', surfaceId, directory });
      if (message.type === 'focus' && isMine(message)) window.focus();
      if (message.type === 'reveal' && isMine(message)) {
        const { mode } = message.tab;
        if (!isContextPanelMode(mode) || mode !== surfaceMode) return;
        const store = useUIStore.getState();
        store.openContextPanelTab(directory, { ...message.tab, mode });
        if (message.fileNavigation) {
          store.setPendingFileFocusPath(null);
          store.setPendingFileNavigation(message.fileNavigation);
        } else if (mode === 'file' && message.tab.targetPath) {
          store.setPendingFileFocusPath(message.tab.targetPath);
        }
        window.focus();
      }
    });
    const announce = () => channel?.post({ type: 'opened', surfaceId, directory });
    announce();
    const heartbeat = window.setInterval(announce, HEARTBEAT_MS);

    const announceClosed = () => channel?.post({ type: 'closed', surfaceId, directory });
    window.addEventListener('pagehide', announceClosed);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', announceClosed);
      announceClosed();
      channel?.close();
    };
  }, [surfaceId, rawDirectory]);
};
