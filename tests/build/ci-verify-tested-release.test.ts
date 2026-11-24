import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error CI runs this dependency-free module directly in Node.js.
import { findTestValidation, waitForTestPush } from '../../scripts/ci-verify-tested-release.mjs';

const repository = 'newbietan/CloudSSH';
const prefix = `/repos/${repository}`;
const candidate = '1'.repeat(40);
const testSha = '2'.repeat(40);
const testedTree = '3'.repeat(40);
const differentTree = '4'.repeat(40);
const workflow = `${prefix}/actions/workflows/deploy.yml/runs?branch=test&event=push&status=success&per_page=30`;
const gitPath = (sha: string) => `${prefix}/git/commits/${sha}`;
const jobsPath = (runId: number, attempt: number) => `${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=20`;
const matchingRuns = `${prefix}/actions/workflows/deploy.yml/runs?branch=test&event=push&head_sha=${testSha}&per_page=10`;
const runDetail = `${prefix}/actions/runs/42`;

const run = {
  id: 42, run_attempt: 2, event: 'push', head_branch: 'test', head_sha: testSha,
  repository: { full_name: repository }, head_repository: { full_name: repository },
  path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success',
};
const fullE2E = 'Browser E2E and accessibility tests';
const testDeployment = 'Deploy verified artifact (test)';
const job = {
  name: 'Validate test', run_id: run.id, run_attempt: run.run_attempt, head_sha: testSha,
  status: 'completed', conclusion: 'success',
  steps: ['Type check', 'Unit and integration tests', 'Build frontend', fullE2E, testDeployment]
    .map(name => ({ name, status: 'completed', conclusion: 'success' })),
};

function api(replies: Record<string, unknown>) {
  return vi.fn(async (path: string, _options?: { allowMissing: boolean }) => {
    if (!Object.hasOwn(replies, path)) throw new Error(`Unexpected API call: ${path}`);
    const reply = replies[path];
    if (reply instanceof Error) throw reply;
    return reply;
  });
}
const check = (get: ReturnType<typeof api>, commit = candidate) =>
  findTestValidation({ repository, commit, tree: testedTree, get });

describe('production promotion from a full test push', () => {
  it('accepts the same Git tree after a squash changed the SHA, including a successful rerun', async () => {
    const get = api({
      [workflow]: { workflow_runs: [run] },
      [gitPath(testSha)]: { sha: testSha, tree: { sha: testedTree } },
      [jobsPath(42, 2)]: { jobs: [job] },
    });
    await expect(check(get)).resolves.toEqual({ runId: 42, runAttempt: 2, testCommit: testSha });
    expect(get.mock.calls.map(([path]) => path)).toEqual([workflow, gitPath(testSha), jobsPath(42, 2)]);
  });

  it('uses an exact commit match without more commit lookups', async () => {
    const get = api({
      [workflow]: { workflow_runs: [run] },
      [jobsPath(42, 2)]: { jobs: [job] },
    });
    await expect(check(get, testSha)).resolves.toMatchObject({ runId: 42 });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rejects a similar PR head if the checkout merge tree differs', async () => {
    const get = api({
      [workflow]: { workflow_runs: [run] },
      [gitPath(testSha)]: { sha: testSha, tree: { sha: differentTree } },
    });
    await expect(check(get)).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    { event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'main' },
    { head_repository: { full_name: 'someone/CloudSSH' } },
    { repository: { full_name: 'someone/CloudSSH' } }, { path: '.github/workflows/other.yml' },
    { status: 'in_progress' }, { conclusion: 'cancelled' }, { run_attempt: 0 },
  ])('does not qualify an untrusted or incomplete source: %j', async variation => {
    const get = api({ [workflow]: { workflow_runs: [{ ...run, ...variation }] } });
    await expect(check(get)).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...job, name: 'A different job' }, { ...job, conclusion: 'failure' },
    { ...job, run_attempt: 1 }, { ...job, run_id: 99 }, { ...job, head_sha: candidate },
    { ...job, steps: job.steps.filter(step => step.name !== fullE2E) },
    { ...job, steps: job.steps.map(step => step.name === fullE2E ? { ...step, conclusion: 'cancelled' } : step) },
    { ...job, steps: job.steps.filter(step => step.name !== testDeployment) },
  ])('does not qualify incomplete or unrelated attempt metadata: %j', async badJob => {
    const get = api({ [workflow]: { workflow_runs: [run] }, [jobsPath(42, 2)]: { jobs: [badJob] } });
    await expect(check(get, testSha)).resolves.toBeNull();
  });

  it.each(['chromium', 'skip'])('ignores a passing reduced %s run and only accepts a matching full run', async profile => {
    const debugSteps = job.steps.map(step => step.name === fullE2E ? { ...step, conclusion: 'skipped' } : step);
    if (profile === 'chromium') debugSteps.push({ name: `${fullE2E} (Chromium only)`, status: 'completed', conclusion: 'success' });
    const skippedProof = { [workflow]: { workflow_runs: [run] }, [jobsPath(42, 2)]: { jobs: [{ ...job, steps: debugSteps }] } };
    await expect(check(api(skippedProof), testSha)).resolves.toBeNull();

    const old = { ...run, id: 41, run_attempt: 1 };
    const full = { ...job, run_id: old.id, run_attempt: old.run_attempt };
    const get = api({
      ...skippedProof,
      [workflow]: { workflow_runs: [run, old] },
      [jobsPath(41, 1)]: { jobs: [full] },
    });
    await expect(check(get, testSha)).resolves.toMatchObject({ runId: 41, runAttempt: 1 });
  });

  it('fails closed if GitHub is unreachable or its evidence is malformed', async () => {
    await expect(check(api({ [workflow]: new Error('GitHub API unavailable') }))).rejects.toThrow('GitHub API unavailable');
    await expect(check(api({ [workflow]: { workflow_runs: null } }))).rejects.toThrow('Invalid GitHub workflow run response');
    const get = api({
      [workflow]: { workflow_runs: [run] },
      [gitPath(testSha)]: { sha: candidate, tree: { sha: testedTree } },
    });
    await expect(check(get)).rejects.toThrow('Invalid GitHub Git commit response');
  });

  it('caps the run search and ignores a commit GitHub no longer supplies', async () => {
    const limited = Array.from({ length: 30 }, (_, i) => ({ ...run, id: 100 + i }));
    const get = api({
      [workflow]: { workflow_runs: [...limited, { ...run, head_sha: candidate }] },
      [gitPath(testSha)]: null,
    });
    await expect(check(get)).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(gitPath(testSha), { allowMissing: true });
  });

  it('refuses a checkout different from the GitHub event SHA before requesting evidence', () => {
    const script = fileURLToPath(new URL('../../scripts/ci-verify-tested-release.mjs', import.meta.url));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const wrong = head === candidate ? testSha : candidate;
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'local-fixture', GITHUB_SHA: wrong },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Checkout does not match the workflow event commit');
  });

  it.each(['push', 'workflow_dispatch'])('does not wait for proof on %s even if given a test head', event => {
    const script = fileURLToPath(new URL('../../scripts/ci-verify-tested-release.mjs', import.meta.url));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const mockFetch = `data:text/javascript,${encodeURIComponent(`
      globalThis.fetch = async input => {
        if (String(input) !== 'https://api.github.com${workflow}') throw Error('unexpected wait request');
        return Response.json({ workflow_runs: [] });
      };
    `)}`;
    const result = spawnSync(process.execPath, ['--import', mockFetch, script], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: 'local-fixture', GITHUB_REPOSITORY: repository,
        GITHUB_SHA: head, GITHUB_EVENT_NAME: event, WAIT_TEST_HEAD: testSha },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No matching full test validation and test deployment');
    expect(result.stderr).not.toContain('unexpected wait request');
  });
});

function waiter(
  replies: Record<string, unknown>,
  { tree = testedTree, head = testSha }: { tree?: string; head?: string } = {}
) {
  let clock = 0;
  const log = vi.fn();
  const now = () => clock;
  const sleep = vi.fn(async (ms: number) => { clock += ms; });
  const responses = {
    [gitPath(testSha)]: { sha: testSha, tree: { sha: testedTree } },
    ...replies,
  };
  const get = vi.fn(async (path: string) => {
    if (!Object.hasOwn(responses, path)) throw new Error(`Unexpected API call: ${path}`);
    const value = responses[path];
    return typeof value === 'function' ? value() : value;
  });
  return { run: () => waitForTestPush({ repository, head, tree, get, log, sleep, now }), get, log, sleep, now };
}

describe('wait for a release PR’s matching test push', () => {
  it('handles indexing delay and a queued run, then requires the full successful attempt', async () => {
    const list = vi.fn()
      .mockReturnValueOnce({ workflow_runs: [] })
      .mockReturnValueOnce({ workflow_runs: [{ ...run, status: 'pending', conclusion: null }] });
    const detail = vi.fn()
      .mockReturnValueOnce({ ...run, status: 'in_progress', conclusion: null })
      .mockReturnValueOnce(run);
    const poll = waiter({ [matchingRuns]: list, [runDetail]: detail, [jobsPath(42, 2)]: { jobs: [job] } });
    await expect(poll.run()).resolves.toEqual({ runId: 42, runAttempt: 2, testCommit: testSha });
    expect(poll.sleep).toHaveBeenCalledTimes(3);
    expect(poll.log).toHaveBeenCalledWith(expect.stringContaining('/actions/runs/42'));
    expect(poll.get).toHaveBeenLastCalledWith(jobsPath(42, 2));
  });

  it('does not wait if the prospective merge tree differs from the test head', async () => {
    const poll = waiter({}, { tree: differentTree });
    await expect(poll.run()).rejects.toThrow('PR merge tree differs');
    expect(poll.get).toHaveBeenCalledExactlyOnceWith(gitPath(testSha), { allowMissing: true });
    expect(poll.sleep).not.toHaveBeenCalled();
  });

  it('bounds the indexing wait and never follows unrelated commits, forks or manual runs', async () => {
    const poll = waiter({ [matchingRuns]: { workflow_runs: [
      { ...run, head_sha: candidate }, { ...run, event: 'workflow_dispatch' },
      { ...run, head_repository: { full_name: 'another/CloudSSH' } },
    ] } });
    await expect(poll.run()).resolves.toBeNull();
    expect(poll.now()).toBe(90_000);
    expect(poll.get).toHaveBeenCalledTimes(6);
  });

  it.each(['failure', 'cancelled'])('fails when the followed test push reports %s', async conclusion => {
    const poll = waiter({
      [matchingRuns]: { workflow_runs: [{ ...run, status: 'queued' }] },
      [runDetail]: { ...run, conclusion },
    });
    await expect(poll.run()).rejects.toThrow('Matching test push did not succeed');
    expect(poll.sleep).toHaveBeenCalledTimes(1);
  });

  it('does not equate a successful reduced-profile run with proof of full validation', async () => {
    const skipped = job.steps.map(step => step.name === fullE2E ? { ...step, conclusion: 'skipped' } : step);
    const poll = waiter({ [matchingRuns]: { workflow_runs: [run] }, [jobsPath(42, 2)]: { jobs: [{ ...job, steps: skipped }] } });
    await expect(poll.run()).rejects.toThrow('did not pass every full validation');
    expect(poll.sleep).not.toHaveBeenCalled();
  });

  it('does not let an indefinitely queued run consume unbounded time', async () => {
    const queued = { ...run, status: 'pending', conclusion: null };
    const poll = waiter({ [matchingRuns]: { workflow_runs: [queued] }, [runDetail]: queued });
    await expect(poll.run()).rejects.toThrow('did not complete within the wait limit');
    expect(poll.now()).toBe(60 * 60_000);
    expect(poll.sleep).toHaveBeenCalledTimes(180);
  });

  it('fails closed if GitHub changes the run identity or reports an API failure', async () => {
    for (const response of [{ ...run, id: 73 }, () => { throw new Error('API unavailable'); }]) {
      const poll = waiter({ [matchingRuns]: { workflow_runs: [{ ...run, status: 'queued' }] }, [runDetail]: response });
      await expect(poll.run()).rejects.toThrow(/different workflow run|API unavailable/);
    }
  });
});
