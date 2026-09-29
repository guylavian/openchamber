export interface OpenCodeUpgradeCapabilityInput {
  isExternal: boolean;
  hasManagedProcess: boolean;
  activeBinary: string | null | undefined;
  isBundledBinary: (binary: string) => boolean;
}

export interface OpenCodeUpgradeCapability {
  supported: boolean;
  manager: 'external' | 'openchamber' | 'opencode' | null;
  reason: 'external' | 'unavailable' | 'bundled' | null;
}

export const resolveOpenCodeUpgradeCapability = ({
  isExternal,
  hasManagedProcess,
  activeBinary,
  isBundledBinary,
}: OpenCodeUpgradeCapabilityInput): OpenCodeUpgradeCapability => {
  if (isExternal) {
    return {
      supported: false,
      manager: 'external',
      reason: 'external',
    };
  }

  if (!hasManagedProcess || !activeBinary) {
    return {
      supported: false,
      manager: null,
      reason: 'unavailable',
    };
  }

  if (isBundledBinary(activeBinary)) {
    return {
      supported: false,
      manager: 'openchamber',
      reason: 'bundled',
    };
  }

  return {
    supported: true,
    manager: 'opencode',
    reason: null,
  };
};
