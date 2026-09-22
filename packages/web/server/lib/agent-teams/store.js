/**
 * Agent teams on disk: `agent-teams.json` (definitions) and
 * `agent-team-runs.json` (run records) in the OpenChamber data dir.
 *
 * Both are OpenChamber's own data, not OpenCode's, and live beside the
 * instance they describe. A missing file is an empty list; a file that is not
 * JSON is an error, so a bad write never silently empties the user's teams.
 * A single record that no longer parses is dropped on its own and the rest
 * load, because one damaged team must not hide the others.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { parseStoredTeam } from './model.js';
import { MEMBER_STATUSES, RUN_STATUSES } from './orchestrator.js';

const FILE_VERSION = 1;
/** Finished runs kept for inspection; running ones are never dropped. */
export const MAX_STORED_RUNS = 20;

const fileSchema = z.object({
  version: z.literal(FILE_VERSION),
  items: z.array(z.unknown()),
}).strict();

const nullableString = z.string().nullable();

const runMemberSchema = z.object({
  agentId: z.string().min(1),
  stageIndex: z.number().int().min(0),
  attempt: z.number().int().min(0),
  status: z.enum(MEMBER_STATUSES),
  sessionId: nullableString,
  directory: nullableString,
  worktree: z.object({ path: z.string(), branch: nullableString }).nullable(),
  model: nullableString,
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  output: nullableString,
  changes: z.object({ directory: z.string(), branch: nullableString, diff: z.string() }).nullable(),
  error: nullableString,
});

const runSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string(),
  goal: z.string(),
  directory: z.string().min(1),
  workspace: z.enum(['isolated', 'shared']),
  team: z.object({ agents: z.array(z.unknown()), stages: z.array(z.unknown()) }),
  status: z.enum(RUN_STATUSES),
  error: nullableString,
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  members: z.array(runMemberSchema),
  timeline: z.array(z.object({
    at: z.number(),
    kind: z.string(),
    memberId: nullableString,
    message: nullableString,
  })),
});

/** A stored run, or null when it does not parse or its team snapshot is damaged. */
export const parseStoredRun = (value) => {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) return null;
  const team = parseStoredTeam({
    id: parsed.data.teamId,
    name: parsed.data.teamName || 'Team',
    workspace: parsed.data.workspace,
    agents: parsed.data.team.agents,
    stages: parsed.data.team.stages,
    createdAt: 'snapshot',
    updatedAt: 'snapshot',
  });
  if (!team) return null;
  const known = new Set(team.agents.map((agent) => agent.id));
  const consistent = parsed.data.members.every((member) => known.has(member.agentId)
    && team.stages[member.stageIndex]?.agentIds.includes(member.agentId));
  if (!consistent) return null;
  return { ...parsed.data, team: { agents: team.agents, stages: team.stages } };
};

const readItems = async (file) => {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const text = raw.replace(/^﻿/, '').trim();
  if (text === '') return [];
  const parsed = fileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid ${path.basename(file)}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  return parsed.data.items;
};

const writeItems = async (file, items) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify({ version: FILE_VERSION, items }, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
};

/** Keeps every running run and the newest finished ones. */
export const pruneRuns = (runs) => {
  const running = runs.filter((run) => run.status === 'running');
  const finished = runs
    .filter((run) => run.status !== 'running')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, MAX_STORED_RUNS - running.length));
  return [...running, ...finished].sort((a, b) => b.createdAt - a.createdAt);
};

export const createAgentTeamsStore = ({ dataDir, logger = console }) => {
  const teamsFile = path.join(dataDir, 'agent-teams.json');
  const runsFile = path.join(dataDir, 'agent-team-runs.json');
  // Writes are serialized per file so a slow write cannot land after a newer one.
  const chains = new Map();
  const serialize = (file, write) => {
    const next = (chains.get(file) ?? Promise.resolve()).then(write, write);
    chains.set(file, next.catch(() => undefined));
    return next;
  };

  const loadValid = async (file, parse, label) => {
    const items = await readItems(file);
    const valid = [];
    for (const item of items) {
      const parsed = parse(item);
      if (parsed) valid.push(parsed);
      else logger.warn?.(`[agent-teams] skipped a ${label} in ${path.basename(file)} that no longer parses`);
    }
    return valid;
  };

  return {
    loadTeams: () => loadValid(teamsFile, parseStoredTeam, 'team'),
    saveTeams: (teams) => serialize(teamsFile, () => writeItems(teamsFile, teams)),
    loadRuns: () => loadValid(runsFile, parseStoredRun, 'run'),
    saveRuns: (runs) => serialize(runsFile, () => writeItems(runsFile, pruneRuns(runs))),
  };
};
