import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import type { SimpleGitFactory } from 'simple-git';

import { createTaskWorkspaceManager } from './task-workspaces.js';

const roots: string[] = [];
const tempDirectory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foreman-worktree-'));
  roots.push(root);
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('Foreman Task workspaces', () => {
  it('reuses a Task worktree for retries and assigns different Tasks different directories', async () => {
    const root = await tempDirectory();
    const repositoryDirectory = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(repositoryDirectory);
    const repository = (simpleGit as typeof simpleGit & SimpleGitFactory)(repositoryDirectory);
    await repository.init();
    await repository.addConfig('user.email', 'foreman@example.invalid');
    await repository.addConfig('user.name', 'Foreman test');
    await fs.writeFile(path.join(repositoryDirectory, 'README.md'), 'repo\n');
    await repository.add('README.md');
    await repository.commit('initial');
    const manager = createTaskWorkspaceManager({ dataDir });
    const first = await manager.prepare({ jobId: 'job', taskId: 'one', baseDirectory: repositoryDirectory });
    const retry = await manager.prepare({ jobId: 'job', taskId: 'one', baseDirectory: repositoryDirectory, existing: first });
    const second = await manager.prepare({ jobId: 'job', taskId: 'two', baseDirectory: repositoryDirectory });
    expect(first.kind).toBe('git-worktree');
    expect(retry.directory).toBe(first.directory);
    expect(second.directory).not.toBe(first.directory);
    const canonical = (directory: string): string => path.resolve(directory).replace(/^\/var\/folders\//, '/private/var/folders/');
    expect(canonical((await (simpleGit as typeof simpleGit & SimpleGitFactory)(first.directory).revparse(['--show-toplevel'])).trim())).toBe(canonical(first.directory));
    expect(canonical((await (simpleGit as typeof simpleGit & SimpleGitFactory)(second.directory).revparse(['--show-toplevel'])).trim())).toBe(canonical(second.directory));
  });

  it('keeps a non-Git directory on a shared, explicitly limited safe path', async () => {
    const root = await tempDirectory();
    const manager = createTaskWorkspaceManager({ dataDir: path.join(root, 'data') });
    const workspace = await manager.prepare({ jobId: 'job', taskId: 'one', baseDirectory: root });
    expect(workspace).toMatchObject({ kind: 'shared-directory', directory: root });
    expect(await manager.prepare({ jobId: 'job', taskId: 'one', baseDirectory: root, existing: workspace })).toEqual(workspace);
  });

  it('removes an explicitly deleted Task worktree and is safe to repeat', async () => {
    const root = await tempDirectory();
    const repositoryDirectory = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(repositoryDirectory);
    const repository = (simpleGit as typeof simpleGit & SimpleGitFactory)(repositoryDirectory);
    await repository.init();
    await repository.addConfig('user.email', 'foreman@example.invalid');
    await repository.addConfig('user.name', 'Foreman test');
    await fs.writeFile(path.join(repositoryDirectory, 'README.md'), 'repo\n');
    await repository.add('README.md');
    await repository.commit('initial');
    const manager = createTaskWorkspaceManager({ dataDir });
    const workspace = await manager.prepare({ jobId: 'job', taskId: 'task', baseDirectory: repositoryDirectory });
    await manager.remove({ jobId: 'job', taskId: 'task', workspace });
    await expect(fs.access(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.remove({ jobId: 'job', taskId: 'task', workspace })).resolves.toBeUndefined();
  });

  it('removes every worktree owned by an explicitly deleted Job', async () => {
    const root = await tempDirectory();
    const repositoryDirectory = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(repositoryDirectory);
    const repository = (simpleGit as typeof simpleGit & SimpleGitFactory)(repositoryDirectory);
    await repository.init();
    await repository.addConfig('user.email', 'foreman@example.invalid');
    await repository.addConfig('user.name', 'Foreman test');
    await fs.writeFile(path.join(repositoryDirectory, 'README.md'), 'repo\n');
    await repository.add('README.md');
    await repository.commit('initial');
    const manager = createTaskWorkspaceManager({ dataDir });
    const tasks = await Promise.all(['one', 'two'].map((taskId) => manager.prepare({ jobId: 'job', taskId, baseDirectory: repositoryDirectory })));
    for (const [index, workspace] of tasks.entries()) {
      await manager.remove({ jobId: 'job', taskId: index === 0 ? 'one' : 'two', workspace });
      await expect(fs.access(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects cleanup for paths outside managed worktree storage', async () => {
    const root = await tempDirectory();
    const manager = createTaskWorkspaceManager({ dataDir: path.join(root, 'data') });
    await expect(manager.remove({
      jobId: 'job', taskId: 'task',
      workspace: { kind: 'git-worktree', directory: root, createdAt: 1 },
    })).rejects.toMatchObject({ code: 'conflict' });
  });
});
