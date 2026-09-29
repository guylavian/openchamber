import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

const isJsonObject = (value: unknown): value is JsonObject => value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype;

const matchesEntry = (value: unknown, pluginDirectory: string): boolean => (
  value === pluginDirectory || (Array.isArray(value) && value[0] === pluginDirectory)
);

/**
 * Append a managed OpenChamber plugin to the `plugins` list of an
 * `OPENCODE_CONFIG_CONTENT` value.
 *
 * OpenCode 2 loads a configured plugin from a DIRECTORY that carries a
 * `package.json` resolving an entrypoint; a path to a single `.js` file is
 * rejected with "configured plugin path must be a directory". So the value
 * merged here is an absolute directory path, not a `file://` URL.
 *
 * Existing entries are preserved and an earlier entry for the same directory is
 * dropped, so a restart never registers the same plugin twice. A legacy
 * `plugin` key is folded into `plugins` and removed: OpenCode still decodes it,
 * but keeping two keys would mean two places to dedupe against.
 *
 * This is the FALLBACK path only, taken when the user's own environment owns
 * `OPENCODE_CONFIG`. Otherwise managed plugins are published through the
 * watched config file in `managed-config-file.js`, which is what makes a
 * managed-tool toggle apply without a restart.
 *
 * @param {string | undefined} rawConfig the current `OPENCODE_CONFIG_CONTENT`, JSONC or unset
 * @param {string} pluginDirectory absolute path of the materialized plugin directory
 * @param {string} purpose short noun phrase for the error message, e.g. "managed tool"
 * @returns {string} the merged config as JSON
 */
export const appendManagedPlugin = (rawConfig: string | null | undefined, pluginDirectory: string, purpose: string): string => {
  const errors: ParseError[] = [];
  const text = (rawConfig ?? '').trim();
  const parsed: unknown = text ? parseJsonc(text, errors, { allowTrailingComma: true }) : {};
  if (errors.length > 0 || !isJsonObject(parsed)) {
    throw new Error(`OPENCODE_CONFIG_CONTENT must contain a valid JSON object before OpenChamber can inject its ${purpose}`);
  }
  for (const key of ['plugin', 'plugins']) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
      throw new Error(`OPENCODE_CONFIG_CONTENT ${key} must be an array before OpenChamber can inject its ${purpose}`);
    }
  }
  const configured = [
    ...(Array.isArray(parsed.plugin) ? parsed.plugin : []),
    ...(Array.isArray(parsed.plugins) ? parsed.plugins : []),
  ];
  delete parsed.plugin;
  parsed.plugins = [
    ...configured.filter((value) => !matchesEntry(value, pluginDirectory)),
    pluginDirectory,
  ];
  return JSON.stringify(parsed);
};
