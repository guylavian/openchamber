import React from 'react';

/**
 * Where the Files editor is drawn right now: the slot inside the zone that
 * holds Files, how that zone wants it shown, and that zone's key handling.
 */
export type FilesEditorPlacement = {
  element: HTMLElement;
  visible: boolean;
  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => void;
};

type FilesEditorWorkspace = {
  getPlacement: () => FilesEditorPlacement | null;
  setPlacement: (next: FilesEditorPlacement | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export const createFilesEditorWorkspace = (): FilesEditorWorkspace => {
  let placement: FilesEditorPlacement | null = null;
  const listeners = new Set<() => void>();
  return {
    getPlacement: () => placement,
    setPlacement: (next) => {
      placement = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const FilesEditorContext = React.createContext<FilesEditorWorkspace | null>(null);

export const useFilesEditorWorkspace = (): FilesEditorWorkspace => {
  const workspace = React.useContext(FilesEditorContext);
  if (!workspace) throw new Error('Files editor slots and hosts must be inside FilesEditorProvider');
  return workspace;
};
