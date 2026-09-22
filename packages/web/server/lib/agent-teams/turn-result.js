/**
 * How a member's turn ended, read from its session's newest message records.
 *
 * OpenCode 2.x closes every turn with an `idle` record whose `outcome` says
 * whether it succeeded, failed or was interrupted, and an assistant record
 * carries `error` when the model call itself failed. A member counts as done
 * only when neither says otherwise; its output is the text of its last answer.
 */
import { z } from 'zod';

// Only the fields read here; anything else on a record is left alone.
const idleSchema = z.object({ type: z.literal('idle'), outcome: z.string().optional() });
const assistantSchema = z.object({
  type: z.literal('assistant'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).nullish(),
});
const recordSchema = z.union([idleSchema, assistantSchema]);

const textOf = (answer) => (answer.content ?? [])
  .filter((item) => item.type === 'text' && item.text)
  .map((item) => item.text)
  .join('')
  .trim();

/**
 * @param {Array<object>} newestFirst message records, newest first (`order: 'desc'`)
 * @returns {{ ok: true, output: string } | { ok: false, error: string }}
 */
export const readTurnResult = (newestFirst) => {
  const records = (Array.isArray(newestFirst) ? newestFirst : [])
    .map((record) => recordSchema.safeParse(record))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  const idle = records.find((record) => record.type === 'idle');
  const answers = records.filter((record) => record.type === 'assistant');

  const error = answers[0]?.error;
  if (error) {
    return { ok: false, error: error.message?.trim() || error.type || 'The model call failed' };
  }
  if (idle?.outcome === 'failed') return { ok: false, error: 'The session reported that its turn failed.' };
  if (idle?.outcome === 'interrupted') return { ok: false, error: 'The session was interrupted.' };

  // A turn can end on a step that only called tools; the answer is the newest
  // assistant record that has text.
  const output = answers.map(textOf).find((text) => text.length > 0) ?? '';
  return { ok: true, output };
};
