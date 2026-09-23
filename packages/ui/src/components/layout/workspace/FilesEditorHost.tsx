import React from 'react';
import { createPortal } from 'react-dom';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

/**
 * Where the Files editor is drawn right now: the slot inside the zone that
 * holds Files, how that zone wants it shown, and that zone's key handling.
 */
type FilesEditorPlacement = {
  element: HTMLElement;
  visible: boolean;
  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => void;
};

// ponytail: one module-level slot, since a window shows one Files surface.
let placement: FilesEditorPlacement | null = null;
const listeners = new Set<() => void>();
const setPlacement = (next: FilesEditorPlacement | null) => {
  placement = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getPlacement = () => placement;

/**
 * Marks where the Files editor goes inside a zone. The editor itself is not
 * rendered here: each zone has its own panel, so rendering it in the zone
 * would remount it, and lose unsaved edits, whenever Files moves to another
 * zone. `FilesEditorHost` renders it once and moves it into this slot.
 */
export const FilesEditorSlot: React.FC<Omit<FilesEditorPlacement, 'element'>> = ({ visible, onKeyDownCapture }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setPlacement({ element, visible, onKeyDownCapture });
    return () => {
      if (placement?.element === element) setPlacement(null);
    };
  }, [onKeyDownCapture, visible]);
  return <div ref={ref} className="h-full w-full" />;
};

/**
 * The one Files editor of the workspace. It stays mounted while Files has an
 * open file, wherever Files is docked and while it is hidden, and its DOM
 * node is moved into the current zone's slot, so a move keeps the same editor
 * with its unsaved edits, undo history and cursor. Between one slot leaving
 * and the next arriving, the node is simply detached.
 *
 * React events from the editor bubble through this component, not through the
 * zone's panel, so the zone's own key handling (Escape collapses the zone) is
 * attached here, taken from the slot.
 */
export const FilesEditorHost: React.FC<{
  mounted: boolean;
  /** The editor, told whether its zone shows it. */
  renderEditor: (visible: boolean) => React.ReactNode;
}> = ({ mounted, renderEditor }) => {
  const current = React.useSyncExternalStore(subscribe, getPlacement, getPlacement);
  const [node] = React.useState(() => document.createElement('div'));
  React.useLayoutEffect(() => {
    node.className = 'h-full w-full';
    if (current && node.parentElement !== current.element) current.element.appendChild(node);
  }, [current, node]);

  if (!mounted) return null;
  return createPortal(
    <div className="h-full w-full" onKeyDownCapture={current?.onKeyDownCapture}>
      <ErrorBoundary>
        <React.Suspense fallback={null}>
          {renderEditor(current?.visible ?? false)}
        </React.Suspense>
      </ErrorBoundary>
    </div>,
    node,
  );
};
