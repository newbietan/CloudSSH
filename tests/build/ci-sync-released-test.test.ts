import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error CI runs this dependency-free module directly in Node.js.
import { releaseGit, syncReleasedTest } from '../../scripts/ci-sync-released-test.mjs';

const release = '1'.repeat(40);
const tested = '2'.repeat(40);
const tree = '3'.repeat(40);
const newer = '4'.repeat(40);
const repo = { full_name: 'newbietan/CloudSSH' };
const merged = (sha = release, head = tested) => ({
  state: 'closed', merged_at: '2026-11-25T12:00:00Z', merge_commit_sha: sha,
  base: { ref: 'main', repo }, head: { ref: 'test', sha: head, repo },
});

function fixture() {
  const git = {
    head: () => release, tree: () => tree,
    refs: vi.fn((): { main?: string; test?: string } => ({ main: release, test: tested })),
    push: vi.fn(),
  };
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path === `commits/${release}/pulls?per_page=100`) return [merged()];
    if (path === `git/commits/${tested}`) return { sha: tested, tree: { sha: tree } };
    throw new Error('Unexpected request');
  });
  return { git, get, run: () => syncReleasedTest({ release, tested, git, get }) };
}

describe('release branch alignment policy', () => {
  it.each([
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/test' }, { GITHUB_REPOSITORY: 'someone/CloudSSH' }, { GH_TOKEN: '' },
  ])('rejects non-production CLI context before any Git or API access: %j', (override) => {
    const script = fileURLToPath(new URL('../../scripts/ci-sync-released-test.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
      GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: repo.full_name,
      GH_TOKEN: 'unused', ...override,
    } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected a production push job token');
  });

  it('requires a verified SHA and the actual deployed checkout', async () => {
    const { git, get } = fixture();
    for (const [commit, proof] of [[newer, tested], [release, ''], [release, '0'.repeat(40)]]) {
      await expect(syncReleasedTest({ release: commit, tested: proof, git, get })).rejects.toThrow();
    }
    expect(get).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  const pr = merged();
  const foreign = { full_name: 'someone/CloudSSH' };
  it.each([
    ['no associated PR', []], ['ambiguous PR', [pr, pr]],
    ['potentially truncated page', [pr, ...Array(99).fill(null)]],
    ['not merged', [{ ...pr, merged_at: null }]], ['open', [{ ...pr, state: 'open' }]],
    ['older merge', [merged(newer)]], ['different proof for same tree', [merged(release, newer)]],
    ['fork', [{ ...pr, head: { ...pr.head, repo: foreign } }]],
    ['other base repository', [{ ...pr, base: { ...pr.base, repo: foreign } }]],
    ['different source branch', [{ ...pr, head: { ...pr.head, ref: 'dev' } }]],
    ['different target branch', [{ ...pr, base: { ...pr.base, ref: 'test' } }]],
  ])('does not write for %s', async (_name, pulls) => {
    const f = fixture();
    f.get.mockResolvedValueOnce(pulls);
    expect(await f.run()).toMatch(/^Skipped:/);
    expect(f.git.refs).not.toHaveBeenCalled();
    expect(f.git.push).not.toHaveBeenCalled();
  });

  it('refuses a different tree even when the head matches the release PR', async () => {
    const f = fixture();
    f.git.tree = () => newer;
    expect(await f.run()).toMatch(/different trees/);
    expect(f.git.push).not.toHaveBeenCalled();
  });

  it('does not write on API errors, bad metadata or missing branch evidence', async () => {
    const f = fixture();
    f.get.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(f.run()).rejects.toThrow('API unavailable');
    f.get.mockResolvedValueOnce({});
    await expect(f.run()).rejects.toThrow('PR response');
    f.get.mockResolvedValueOnce([pr]).mockResolvedValueOnce({ sha: newer, tree: { sha: tree } });
    await expect(f.run()).rejects.toThrow('test commit response');
    f.git.refs.mockImplementationOnce(() => { throw new Error('unavailable'); });
    await expect(f.run()).rejects.toThrow('unavailable');
    expect(f.git.push).not.toHaveBeenCalled();
  });

  it.each([
    [newer, tested, 'main is no longer'], [release, newer, 'test moved'],
    [release, undefined, 'test moved'], [release, release, 'already points'],
  ])('does not write for current refs main=%s test=%s', async (main, test, reason) => {
    const f = fixture();
    f.git.refs.mockReturnValue({ main, test });
    expect(await f.run()).toContain(reason);
    expect(f.git.push).not.toHaveBeenCalled();
  });

  it('reports a permission/transport failure without retrying the write', async () => {
    const f = fixture();
    f.git.push.mockImplementation(() => { throw new Error('cannot push'); });
    await expect(f.run()).rejects.toThrow(/no push was retried/);
    expect(f.git.push.mock.calls).toEqual([[release, tested]]);
  });
});

// Use a real shallow main checkout against a disposable bare remote. No GitHub credentials,
// network or test head checkout is needed to exercise the server-side compare-and-swap.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function bareRelease() {
  const root = mkdtempSync(join(tmpdir(), 'cloudssh-release-'));
  dirs.push(root);
  const dev = join(root, 'dev');
  const deployed = join(root, 'deployed');
  const origin = join(root, 'origin.git');
  const remote = pathToFileURL(origin).href;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@example.test',
      GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@example.test',
    },
  }).trim();
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'main', dev);
  git(dev, 'commit', '--allow-empty', '-m', 'base');
  git(dev, 'switch', '-c', 'test');
  writeFileSync(join(dev, 'version'), '2.12.5\n');
  git(dev, 'add', 'version');
  git(dev, 'commit', '-m', 'candidate');
  const tested = git(dev, 'rev-parse', 'HEAD');
  const tree = git(dev, 'rev-parse', 'HEAD^{tree}');
  git(dev, 'switch', 'main');
  git(dev, 'merge', '--squash', 'test');
  git(dev, 'commit', '-m', 'squashed release');
  const release = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'push', remote, 'main', 'test');
  git(root, 'clone', '--depth=1', '--single-branch', '--branch', 'main', remote, deployed);
  const transport = releaseGit(remote, deployed);
  const get = async (path: string) => {
    if (path === `commits/${release}/pulls?per_page=100`) return [merged(release, tested)];
    if (path === `git/commits/${tested}`) return { sha: tested, tree: { sha: tree } };
    throw new Error('Unexpected request');
  };
  return { run: () => syncReleasedTest({ release, tested, git: transport, get }),
    transport, git, dev, remote, tested, release, tree };
}

describe('real Git post-deploy lease', () => {
  it('aligns a squash once and safely no-ops on rerun', async () => {
    const f = bareRelease();
    const push = vi.spyOn(f.transport, 'push');
    expect(f.release).not.toBe(f.tested);
    expect(await f.run()).toMatch(/^Aligned test/);
    expect(f.transport.refs()).toEqual({ main: f.release, test: f.release });
    expect(await f.run()).toMatch(/^No change:/);
    expect(push.mock.calls).toEqual([[f.release, f.tested]]);
  });

  it.each(['push', 'delete'])('preserves a concurrent %s between the read and write', async (op) => {
    const f = bareRelease();
    // Even a newer commit with exactly the same tree must not be overwritten.
    const next = f.git(f.dev, 'commit-tree', f.tree, '-p', f.tested, '-m', 'new work');
    const push = f.transport.push;
    f.transport.push = vi.fn((release: string, tested: string) => {
      f.git(f.dev, 'push', f.remote, `${op === 'push' ? next : ''}:refs/heads/test`);
      push(release, tested);
    });
    expect(await f.run()).toContain('test moved or was deleted');
    expect(f.transport.refs()).toEqual({ main: f.release, test: op === 'push' ? next : undefined });
    expect(f.transport.push.mock.calls).toEqual([[f.release, f.tested]]);
  });
});
