/**
 * How a member's turn ended, read from its session's newest message records.
 *
 * OpenCode 2.x closes every turn with an `idle` record whose `outcome` says
 * whether it succeeded, failed or was interrupted, and an assistant record
 * carries `error` when the model call itself failed. A member counts as done
 * only when neither says otherwise; its output is the text of its last answer.
 *
 * @param {Array<object>} newestFirst message records, newest first (`order: 'desc'`)
 * @returns {{ ok: true, output: string } | { ok: false, error: string }}
 */
export const readTurnResult = (newestFirst) => {
  const records = Array.isArray(newestFirst) ? newestFirst : [];
  const idle = records.find((record) => record?.type === 'idle');
  const answer = records.find((record) => record?.type === 'assistant');

  if (answer?.error) {
    const { message, type } = answer.error;
    return { ok: false, error: (typeof message === 'string' && message.trim()) || (typeof type === 'string' && type) || 'The model call failed' };
  }
  if (idle?.outcome === 'failed') return { ok: false, error: 'The session reported that its turn failed.' };
  if (idle?.outcome === 'interrupted') return { ok: false, error: 'The session was interrupted.' };

  // A turn can end on a step that only called tools; the answer is the newest
  // assistant record that has text.
  for (const record of records) {
    if (record?.type !== 'assistant') continue;
    const output = textOf(record);
    if (output) return { ok: true, output };
  }
  return { ok: true, output: '' };
};

const textOf = (record) => (Array.isArray(record.content) ? record.content : [])
  .filter((item) => item?.type === 'text' && typeof item.text === 'string')
  .map((item) => item.text)
  .join('')
  .trim();
