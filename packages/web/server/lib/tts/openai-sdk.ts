/**
 * The OpenAI SDK is ~200 modules and only speech and transcription use it, so
 * it is loaded on the first call rather than with the server.
 */

type OpenAIClass = typeof import('openai').default;

let pending: Promise<OpenAIClass> | undefined;

export const loadOpenAI = (): Promise<OpenAIClass> => {
  pending ??= import('openai').then((module) => module.default);
  return pending;
};
