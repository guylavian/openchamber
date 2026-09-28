import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';

import { ForemanStoreError } from './store.js';

const workspaceKey = (jobId, taskId) => crypto.createHash('sha256').update(`${jobId}:${taskId}`).digest('hex').slice(0, 20);
const canonicalDirectory = (value) => path.resolve(value).replace(/^\/var\/folders\//, '/private/var/folders/');
const sameDirectory = (left, right) => canonicalDirectory(left) === canonicalDirectory(right);

/** Owns the only Git worktree operations used by Foreman. */
export const createTaskWorkspaceManager = ({ dataDir, git = simpleGit, fsPromises = fs, pathModule = path, now = Date.now }) => ({
  async prepare({ jobId, taskId, baseDirectory, existing }) {
    if (existing) {
      if (existing.kind === 'shared-directory') {
        if (existing.directory !== baseDirectory) throw new ForemanStoreError('conflict', 'The Task workspace no longer matches its Job directory');
        return existing;
      }
      const target = pathModule.resolve(dataDir, 'foreman-worktrees', workspaceKey(jobId, taskId));
      if (existing.directory !== target) throw new ForemanStoreError('conflict', 'The stored Task worktree path is invalid');
      try {
        await fsPromises.access(target);
        const root = await git(target).revparse(['--show-toplevel']);
        if (!sameDirectory(root.trim(), target)) throw new Error('wrong worktree root');
      } catch {
        throw new ForemanStoreError('conflict', 'The Task worktree is missing or invalid; restore it before retrying');
      }
      return existing;
    }

    const repository = git(baseDirectory);
    let isRepository = false;
    try { isRepository = await repository.checkIsRepo(); } catch { isRepository = false; }
    if (!isRepository) return { kind: 'shared-directory', directory: baseDirectory, createdAt: now() };

    const target = pathModule.resolve(dataDir, 'foreman-worktrees', workspaceKey(jobId, taskId));
    const branch = `openchamber/foreman-${workspaceKey(jobId, taskId)}`;
    await fsPromises.mkdir(pathModule.dirname(target), { recursive: true });
    const worktrees = await repository.raw(['worktree', 'list', '--porcelain']);
    const registered = worktrees.split(/\r?\n/).some((line) => line.startsWith('worktree ') && sameDirectory(line.slice('worktree '.length), target));
    if (registered) {
      await fsPromises.access(target);
      const root = await git(target).revparse(['--show-toplevel']);
      if (!sameDirectory(root.trim(), target)) throw new ForemanStoreError('conflict', 'An unrelated repository occupies the Task worktree path');
    } else {
      try { await fsPromises.access(target); throw new ForemanStoreError('conflict', 'An unrelated directory occupies the Task worktree path'); }
      catch (error) { if (error instanceof ForemanStoreError) throw error; }
      await repository.raw(['worktree', 'add', '-b', branch, target]);
    }
    return { kind: 'git-worktree', directory: target, createdAt: now() };
  },
  async remove({ jobId, taskId, workspace }) {
    if (!workspace || workspace.kind !== 'git-worktree') return;
    const target = pathModule.resolve(dataDir, 'foreman-worktrees', workspaceKey(jobId, taskId));
    if (!sameDirectory(workspace.directory, target)) throw new ForemanStoreError('conflict', 'The stored Task worktree path is invalid');
    const parentDirectory = pathModule.resolve(dataDir, 'foreman-worktrees');
    if (!sameDirectory(pathModule.dirname(target), parentDirectory)) throw new ForemanStoreError('conflict', 'The Task worktree is outside Foreman storage');
    try { await fsPromises.access(target); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    const worktrees = await git(workspace.directory).raw(['worktree', 'list', '--porcelain']);
    const registered = worktrees.split(/\r?\n/).some((line) => line.startsWith('worktree ') && sameDirectory(line.slice('worktree '.length), target));
    if (!registered) {
      throw new ForemanStoreError('conflict', 'The stored Task directory is not a registered Git worktree');
    }
    await git(workspace.directory).raw(['worktree', 'remove', '--force', target]);
  },
});
