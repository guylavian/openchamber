import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ContextMenuItem } from '@/components/ui/context-menu';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import {
  allowedZonesForSurface,
  WORKSPACE_ZONES,
  type WorkspaceZone,
} from '@/lib/workspace/layout';
import { canDetachSurface } from '@/lib/workspace/surfaceWindow';
import { detachSurface } from './useSurfaceWindows';

const ZONE_PRESENTATION = {
  left: { icon: 'layout-left', labelKey: 'workspace.move.left' },
  center: { icon: 'layout-column', labelKey: 'workspace.move.center' },
  right: { icon: 'layout-right', labelKey: 'workspace.move.right' },
  bottom: { icon: 'layout-bottom-2', labelKey: 'workspace.move.bottom' },
} satisfies Record<WorkspaceZone, { icon: IconName; labelKey: I18nKey }>;

type Props = {
  /** Registry id of the surface being moved, or null when it cannot be resolved. */
  surfaceId: string | null;
  currentZone: WorkspaceZone;
};

/**
 * The docking rows of a surface's context menu: "Move to ..." for each zone
 * it allows, then "Open in new window".
 *
 * The zone it is already in is shown as its current place rather than hidden,
 * so the menu says where the surface lives as well as where it can go.
 */
export const WorkspaceMoveMenuItems: React.FC<Props> = ({ surfaceId, currentZone }) => {
  const { t } = useI18n();
  const moveWorkspaceSurface = useUIStore((state) => state.moveWorkspaceSurface);
  const directory = useEffectiveDirectory() ?? '';

  if (!surfaceId) return null;

  const allowed = allowedZonesForSurface(surfaceId);
  const targets = WORKSPACE_ZONES.filter((zone) => allowed.includes(zone));
  const canMove = targets.length >= 2;
  // A window needs a project to show; with none selected there is nothing to
  // put in it.
  const canDetach = canDetachSurface(surfaceId) && directory.length > 0;
  if (!canMove && !canDetach) return null;

  return (
    <>
      {canMove ? targets.map((zone) => {
        const presentation = ZONE_PRESENTATION[zone];
        return (
          <ContextMenuItem
            key={zone}
            disabled={zone === currentZone}
            onClick={() => {
              moveWorkspaceSurface(surfaceId, zone, { revealIn: directory });
            }}
          >
            <Icon name={presentation.icon} className="mr-2 size-4" />
            {t(presentation.labelKey)}
          </ContextMenuItem>
        );
      }) : null}
      {canDetach ? (
        <ContextMenuItem onClick={() => { void detachSurface(surfaceId, directory); }}>
          <Icon name="external-link" className="mr-2 size-4" />
          {t('workspace.move.newWindow')}
        </ContextMenuItem>
      ) : null}
    </>
  );
};
