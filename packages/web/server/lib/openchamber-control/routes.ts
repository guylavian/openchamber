import express from 'express';
import { asControlError } from './error.js';
import type { Express, Request } from 'express';
import type { OpenChamberControlError } from './error.js';

interface ControlService {
  execute: (action: string, input: object, contextDirectory: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
}

type ControlRequestBody = { action?: unknown; input?: unknown; contextDirectory?: unknown } | null | undefined;

type PartialControlError = OpenChamberControlError & { partial?: unknown; partialAction?: unknown; sessionId?: unknown; directory?: unknown };

export const registerOpenChamberControlRoutes = (app: Express, { controlService }: { controlService: ControlService }) => {
  app.post('/api/openchamber/control', express.json({ limit: '1mb' }), async (req: Request<Record<string, never>, unknown, ControlRequestBody>, res) => {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    try {
      const action = typeof req.body?.action === 'string' ? req.body.action : '';
      const requestInput = req.body?.input;
      const input = requestInput && typeof requestInput === 'object' && !Array.isArray(requestInput)
        ? requestInput
        : {};
      const data = await controlService.execute(action, input, req.body?.contextDirectory, { signal: controller.signal });
      return res.json(data);
    } catch (error) {
      const controlError: PartialControlError = asControlError(error as Parameters<typeof asControlError>[0], 'OpenChamber control action failed');
      return res.status(controlError.statusCode).json({
        error: controlError.message,
        ...(controlError.partial === true ? {
          partial: true,
          partialAction: controlError.partialAction,
          sessionId: controlError.sessionId,
          directory: controlError.directory,
        } : {}),
      });
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  });
};
