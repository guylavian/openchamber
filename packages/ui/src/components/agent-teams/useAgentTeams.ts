import React from 'react';

import { fetchAgentTeams, fetchTeamRun, fetchTeamRuns, type AgentTeam, type TeamRun } from '@/lib/agent-teams/api';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

/** Refreshes coalesce: a burst of run events becomes one read. */
const REFRESH_DELAY_MS = 250;

type Loaded<T> = { data: T | null; error: string | null };

/**
 * Teams and the run list, kept current from the server. The server is the
 * authority: a failed read keeps what was already shown and reports the
 * error, and a reconnected event stream triggers a fresh read.
 */
export const useAgentTeams = () => {
  const [teams, setTeams] = React.useState<Loaded<AgentTeam[]>>({ data: null, error: null });
  const [runs, setRuns] = React.useState<Loaded<TeamRun[]>>({ data: null, error: null });

  const reloadTeams = React.useCallback(async () => {
    try {
      const data = await fetchAgentTeams();
      setTeams({ data, error: null });
    } catch (error) {
      setTeams((previous) => ({ data: previous.data, error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);

  const reloadRuns = React.useCallback(async () => {
    try {
      const data = await fetchTeamRuns();
      setRuns({ data, error: null });
    } catch (error) {
      setRuns((previous) => ({ data: previous.data, error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);

  React.useEffect(() => {
    void reloadTeams();
    void reloadRuns();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'agent-teams-updated') void reloadTeams();
      if (event.type === 'event-stream-ready') {
        void reloadTeams();
        void reloadRuns();
      }
      if (event.type === 'agent-team-run-updated' && !timer) {
        timer = setTimeout(() => {
          timer = null;
          void reloadRuns();
        }, REFRESH_DELAY_MS);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [reloadTeams, reloadRuns]);

  return { teams, runs, reloadTeams, reloadRuns };
};

/** One run with its outputs and diffs, re-read whenever the server reports a change to it. */
export const useTeamRun = (runId: string | null) => {
  const [state, setState] = React.useState<Loaded<TeamRun> & { runId: string | null }>({ data: null, error: null, runId: null });

  const reload = React.useCallback(async () => {
    if (!runId) return;
    try {
      const data = await fetchTeamRun(runId);
      setState({ data, error: null, runId });
    } catch (error) {
      setState((previous) => ({ data: previous.runId === runId ? previous.data : null, error: error instanceof Error ? error.message : String(error), runId }));
    }
  }, [runId]);

  React.useEffect(() => {
    if (!runId) return undefined;
    void reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      const relevant = event.type === 'event-stream-ready' || (event.type === 'agent-team-run-updated' && event.runId === runId);
      if (!relevant || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void reload();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [runId, reload]);

  // A run id that no longer matches what was loaded shows nothing stale.
  const current = state.runId === runId ? state : { data: null, error: null };
  return { run: current.data, error: current.error, reload, setRun: (run: TeamRun) => setState({ data: run, error: null, runId: run.id }) };
};

/** The current time, ticking once a second while `active`, for elapsed counters. */
export const useNow = (active: boolean) => {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};
