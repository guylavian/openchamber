import React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useI18n } from '@/lib/i18n';
import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';
import { cn } from '@/lib/utils';
import { modeForSurface } from '@/lib/workspace/surfaceWindow';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { ContextPanel } from '../ContextPanel';
import { useSurfaceWindowPresence } from './useSurfaceWindows';

type Props = {
  surfaceId: string;
  directory: string;
};

/**
 * A single surface in a window of its own. The main window hides the surface
 * while this window is open and takes it back when this window closes.
 */
export const SurfaceWindowLayout: React.FC<Props> = ({ surfaceId, directory }) => {
  const { t } = useI18n();
  const guestSurfaces = useGuestSurfaces();
  useSurfaceWindowPresence(surfaceId, directory);
  // A detached terminal is still the same session; keep it alive from here.
  useTerminalSessionKeepalive();

  // This window shows the project the surface was detached from. It has no
  // session of its own, so it opens a draft pointed at that project: surfaces
  // resolve their directory from the active session or draft, and the
  // terminal refuses to start without one. `automatic` because this is not the
  // user choosing a draft — a user-initiated open would drop the shared
  // "reopen the last session" pointer the main window restores on launch.
  React.useEffect(() => {
    useDirectoryStore.getState().setDirectory(directory, { showOverlay: false });
    const sessionUI = useSessionUIStore.getState();
    if (!sessionUI.currentSessionId) {
      sessionUI.openNewSessionDraft({ automatic: true, directoryOverride: directory });
    }
  }, [directory]);

  // A surface detached before it ever had a tab still needs one to draw.
  React.useEffect(() => {
    const mode = modeForSurface(surfaceId);
    if (!mode) return;
    const key = normalizeContextPanelDirectoryKey(directory);
    const store = useUIStore.getState();
    const hasTab = (store.contextPanelByDirectory[key]?.tabs ?? []).some((tab) => tab.mode === mode);
    if (!hasTab) store.openContextPanelTab(key, { mode }, { reveal: false });
  }, [directory, surfaceId]);

  const descriptor = CONTEXT_SURFACES.find((surface) => surface.id === surfaceId)
    ?? guestSurfaces.find((surface) => surface.id === surfaceId);
  const title = descriptor ? descriptor.label ?? t(descriptor.labelKey) : surfaceId;

  React.useEffect(() => {
    document.title = title;
  }, [title]);

  const macosMajor = window.__OPENCHAMBER_MACOS_MAJOR__ ?? 0;
  const hasMacTrafficLights = Number.isFinite(macosMajor) && macosMajor > 0;
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      {/* Drag strip. Native traffic lights are fixed-size OS chrome, so the
          inset is in pixels, matching the mini chat window. */}
      <header
        className={cn(
          'app-region-drag flex h-10 shrink-0 items-center gap-2 border-b border-border',
          hasMacTrafficLights ? 'pl-[88px]' : 'pl-3',
          usesFramelessChrome && windowControlsSide === 'right' ? 'pr-0' : 'pr-3',
        )}
      >
        {usesFramelessChrome && windowControlsSide === 'left' ? (
          <WindowsWindowControls visible position="left" />
        ) : null}
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{title}</span>
        {usesFramelessChrome && windowControlsSide === 'right' ? (
          <WindowsWindowControls visible position="right" />
        ) : null}
      </header>
      <div className="relative min-h-0 flex-1">
        <ErrorBoundary>
          <ContextPanel zone="center" standaloneSurfaceId={surfaceId} />
        </ErrorBoundary>
      </div>
    </div>
  );
};
