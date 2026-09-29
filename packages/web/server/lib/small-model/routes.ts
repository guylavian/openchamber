import type { Express, Request } from 'express';

interface GenerateBody {
  prompt?: unknown;
  system?: unknown;
  maxOutputTokens?: unknown;
  model?: unknown;
  directory?: unknown;
  sessionID?: unknown;
  preferredProviderID?: unknown;
  preferredModelID?: unknown;
  restrictToPreferredProvider?: unknown;
}

interface SmallModelService {
  describeSmallModel: (options: { directory: string | undefined; preferredProviderID: string | undefined; preferredModelID: string | undefined }) => Promise<unknown>;
  listAuthenticatedProviders: () => Promise<unknown>;
  generateSmallModelText: (options: Omit<GenerateBody, 'restrictToPreferredProvider'> & { restrictToPreferredProvider: boolean }) => Promise<unknown>;
}

type ServiceError = { message?: unknown; statusCode?: unknown; code?: unknown };

export function registerSmallModelRoutes(app: Express, { getSmallModelService }: { getSmallModelService: () => Promise<SmallModelService> }) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listAuthenticatedProviders } = await getSmallModelService();
      const resolved = await describeSmallModel({
        directory: typeof req.query.directory === 'string' ? req.query.directory : undefined,
        preferredProviderID: typeof req.query.providerID === 'string' ? req.query.providerID : undefined,
        preferredModelID: typeof req.query.modelID === 'string' ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listAuthenticatedProviders(),
      });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: (error as ServiceError).message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req: Request<Record<string, never>, unknown, GenerateBody | undefined>, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, sessionID, preferredProviderID, preferredModelID, restrictToPreferredProvider } = req.body || {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        sessionID,
        preferredProviderID,
        preferredModelID,
        restrictToPreferredProvider: restrictToPreferredProvider === true,
      });
      res.json(result);
    } catch (error) {
      const statusCode = Number((error as ServiceError | null | undefined)?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      res.status(statusCode).json({
        error: statusCode === 404 || (error as ServiceError | null | undefined)?.code === 'small-model-unavailable'
          ? ((error as ServiceError).message || 'No small model is available')
          : 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
        ...((error as ServiceError | null | undefined)?.code ? { code: (error as ServiceError).code } : {}),
      });
    }
  });
}
