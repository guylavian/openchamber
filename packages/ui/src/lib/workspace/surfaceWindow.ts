import { z } from 'zod';

import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';
import { isPluginContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';

/**
 * A surface detached into its own window, for one project.
 *
 * The window is the ordinary app page booted with `?ocWindow=surface`, so it
 * runs the same code as the main window and shows only one surface. While it
 * is open the main window hides that surface for that project; closing it
 * puts the surface back in the zone it came from. The windows talk over a
 * same-origin BroadcastChannel, which works identically in a browser and in
 * Electron, where both windows are served from the same UI origin.
 *
 * Each window has its own store, so anything the main window opens for a
 * detached surface (a file link, a diff) is forwarded to that window with a
 * `reveal` message rather than landing in the main window's hidden copy.
 *
 * Runtimes: web opens a browser popup; Electron asks the main process for a
 * window (renderer `window.open` is routed to the system browser there).
 * VS Code and the mobile shells never render the menu that offers this.
 */

const SURFACE_WINDOW_QUERY = 'ocWindow';
const SURFACE_WINDOW_VALUE = 'surface';
const CHANNEL_NAME = 'openchamber:surface-windows';

/**
 * The session conversation cannot be detached: only one live chat view may
 * exist, and a chat in its own window is what the mini chat window is for.
 */
export const canDetachSurface = (surfaceId: string): boolean => surfaceId !== 'chat' && modeForSurface(surfaceId) !== null;

export const modeForSurface = (surfaceId: string): ContextPanelMode | null => {
  const descriptor = CONTEXT_SURFACES.find((surface) => surface.id === surfaceId);
  if (descriptor) return descriptor.mode;
  return isPluginContextPanelMode(surfaceId) ? surfaceId : null;
};

type SurfaceWindowParams = {
  surfaceId: string;
  directory: string;
};

/** The surface this page was opened to show, or null for an ordinary window. */
export const readSurfaceWindowParams = (search: string): SurfaceWindowParams | null => {
  const params = new URLSearchParams(search);
  if (params.get(SURFACE_WINDOW_QUERY) !== SURFACE_WINDOW_VALUE) return null;
  const surfaceId = (params.get('surface') ?? '').trim();
  const directory = (params.get('directory') ?? '').trim();
  if (!surfaceId || !directory || !canDetachSurface(surfaceId)) return null;
  return { surfaceId, directory };
};

export const buildSurfaceWindowSearch = ({ surfaceId, directory }: SurfaceWindowParams): string => {
  const params = new URLSearchParams();
  params.set(SURFACE_WINDOW_QUERY, SURFACE_WINDOW_VALUE);
  params.set('surface', surfaceId);
  params.set('directory', directory);
  return `?${params.toString()}`;
};

/** The parts of a panel tab worth carrying to another window to reopen it there. */
const forwardedTabSchema = z.object({
  mode: z.string(),
  targetPath: z.string().nullable(),
  targetDirectory: z.string().nullable(),
  dedupeKey: z.string(),
  label: z.string().nullable(),
  sessionTitleFallback: z.string().nullable(),
  readOnly: z.boolean(),
  stagedDiff: z.boolean(),
  diffScope: z.enum(['working', 'staged', 'turn', 'branch', 'commit', 'pr']).nullable(),
});

const fileNavigationSchema = z.object({ path: z.string(), line: z.number(), column: z.number() });

// `directory` is always the normalized context-panel key of the project.
const surfaceWindowMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened'), surfaceId: z.string(), directory: z.string() }),
  z.object({ type: z.literal('closed'), surfaceId: z.string(), directory: z.string() }),
  z.object({ type: z.literal('focus'), surfaceId: z.string(), directory: z.string() }),
  z.object({
    type: z.literal('reveal'),
    surfaceId: z.string(),
    directory: z.string(),
    tab: forwardedTabSchema,
    fileNavigation: fileNavigationSchema.nullable(),
  }),
  // A main window that just loaded asks which surface windows are open, so a
  // reload does not forget that a surface lives elsewhere.
  z.object({ type: z.literal('roll-call') }),
]);

type SurfaceWindowMessage = z.infer<typeof surfaceWindowMessageSchema>;

/**
 * Opens the shared channel. Returns null where BroadcastChannel is missing,
 * which only happens in test environments; callers then simply do not sync.
 */
export const openSurfaceWindowChannel = (onMessage: (message: SurfaceWindowMessage) => void) => {
  if (!('BroadcastChannel' in globalThis)) return null;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => {
    const parsed = surfaceWindowMessageSchema.safeParse(event.data);
    if (parsed.success) onMessage(parsed.data);
  };
  return {
    post: (message: SurfaceWindowMessage) => channel.postMessage(message),
    close: () => channel.close(),
  };
};

/**
 * What opening a detached window produced: refused (a blocked popup, a failed
 * desktop call), opened with a handle this window can watch (web), or opened
 * with no handle (Electron, where the window belongs to the main process).
 */
type SurfaceWindowOpenResult =
  | { status: 'refused' }
  | { status: 'opened'; popup: Window | null };

export const openSurfaceWindow = async (params: SurfaceWindowParams): Promise<SurfaceWindowOpenResult> => {
  if (isElectronShell()) {
    try {
      await invokeDesktop('desktop_open_surface_window', { surfaceId: params.surfaceId, directory: params.directory });
      return { status: 'opened', popup: null };
    } catch (error) {
      console.warn('[workspace] failed to open surface window', error);
      return { status: 'refused' };
    }
  }

  const url = `${window.location.origin}${window.location.pathname}${buildSurfaceWindowSearch(params)}`;
  // Named per surface and project, so asking again focuses the existing
  // window instead of opening a second copy.
  const name = `openchamber-surface-${params.surfaceId}-${encodeURIComponent(params.directory)}`;
  const popup = window.open(url, name, 'popup,width=960,height=720');
  return popup ? { status: 'opened', popup } : { status: 'refused' };
};
