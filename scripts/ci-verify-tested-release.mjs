import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const WORKFLOW = '.github/workflows/deploy.yml';
const TEST_JOB = 'Validate test';
const MAX_RUNS = 30;
const INDEX_WAIT_MS = 90_000;
const RUN_WAIT_MS = 60 * 60_000;
const POLL_MS = 20_000;
const EVIDENCE_RETRY_MS = [2_000, 4_000, 8_000, 12_000];
const ACTIVE_STATES = new Set(['queued', 'pending', 'requested', 'waiting', 'in_progress']);
const REQUIRED_STEPS = [
  'Type check',
  'Unit and integration tests',
  'Build frontend',
  'Browser E2E and accessibility tests',
  'Deploy verified artifact (test)',
];
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isId = value => Number.isSafeInteger(value) && value > 0;
const sameRepo = (value, repository) => value?.full_name?.toLowerCase() === repository.toLowerCase();
const isTestPush = (run, repository) =>
  run?.path === WORKFLOW && run.event === 'push' && run.head_branch === 'test' &&
  sameRepo(run.repository, repository) && sameRepo(run.head_repository, repository) &&
  isSha(run.head_sha) && isId(run.id) && isId(run.run_attempt);

async function commitTree(root, sha, get) {
  const info = await get(`${root}/git/commits/${sha}`, { allowMissing: true });
  if (info === null) return null;
  if (info?.sha !== sha || !isSha(info?.tree?.sha)) {
    throw new Error('Invalid GitHub Git commit response.');
  }
  return info.tree.sha;
}

function inspectAttempt(attempt, run) {
  if (attempt === null) return 'pending';
  if (!Array.isArray(attempt?.jobs)) throw new Error('Invalid GitHub workflow job response.');
  const job = attempt.jobs.find(item => item?.name === TEST_JOB && item.run_id === run.id &&
    item.run_attempt === run.run_attempt && item.head_sha === run.head_sha);
  if (!job || job.status !== 'completed' || job.conclusion == null) return 'pending';
  if (job.conclusion !== 'success') return 'rejected';
  if (job.steps == null) return 'pending';
  if (!Array.isArray(job.steps)) throw new Error('Invalid GitHub workflow steps response.');

  const required = job.steps.filter(step => REQUIRED_STEPS.includes(step?.name));
  if (required.some(step => step.status === 'completed' && step.conclusion != null && step.conclusion !== 'success')) {
    return 'rejected';
  }
  return REQUIRED_STEPS.every(name => required.some(step =>
    step.name === name && step.status === 'completed' && step.conclusion === 'success'
  )) ? 'verified' : 'pending';
}

async function verifyAttempt(root, run, { get, sleep, log }) {
  if (run.status !== 'completed' || run.conclusion !== 'success') return null;
  const path = `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=20`;
  for (let index = 0; index <= EVIDENCE_RETRY_MS.length; index++) {
    const evidence = inspectAttempt(await get(path, { allowMissing: true }), run);
    if (evidence === 'verified') {
      return { runId: run.id, runAttempt: run.run_attempt, testCommit: run.head_sha };
    }
    if (evidence === 'rejected' || index === EVIDENCE_RETRY_MS.length) return null;
    // GitHub may mark the run successful before publishing all of this attempt's steps.
    if (index === 0) log(`Waiting for complete step metadata for test run ${run.id}, attempt ${run.run_attempt}.`);
    await sleep(EVIDENCE_RETRY_MS[index]);
  }
  return null;
}

/** Use GitHub-owned run/attempt metadata, not status labels, artifacts or executable files from test. */
export async function findTestValidation({ repository, commit, tree, get, sleep = delay, log = console.log }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !isSha(commit) || !isSha(tree)) {
    throw new Error('Invalid repository or commit metadata.');
  }
  const root = `/repos/${repository}`;
  const data = await get(
    `${root}/actions/workflows/deploy.yml/runs?branch=test&event=push&status=success&per_page=${MAX_RUNS}`
  );
  if (!Array.isArray(data?.workflow_runs)) throw new Error('Invalid GitHub workflow run response.');
  const candidates = data.workflow_runs.slice(0, MAX_RUNS).filter(run =>
    isTestPush(run, repository) && run.status === 'completed' && run.conclusion === 'success'
  );
  const trees = new Map([[commit, tree]]);
  // Exact commit matches are common after syncing branches. Squashes can use a different SHA.
  candidates.sort((a, b) => Number(b.head_sha === commit) - Number(a.head_sha === commit));
  for (const run of candidates) {
    if (!trees.has(run.head_sha)) trees.set(run.head_sha, await commitTree(root, run.head_sha, get));
    if (trees.get(run.head_sha) !== tree) continue;
    const result = await verifyAttempt(root, run, { get, sleep, log });
    if (result) return result;
  }
  return null;
}

/** Release PR only: follow the matching test push, even while queued behind an older deployment. */
export async function waitForTestPush({
  repository, head, tree, get, log = console.log, now = () => performance.now(), sleep = delay,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !isSha(head) || !isSha(tree)) return null;
  const root = `/repos/${repository}`;
  if (await commitTree(root, head, get) !== tree) {
    throw new Error('The PR merge tree differs from the test branch candidate. Sync main into test and fully validate the resulting tree.');
  }
  const matches = run => isTestPush(run, repository) && run.head_sha === head;
  const indexUntil = now() + INDEX_WAIT_MS;
  const waitUntil = now() + RUN_WAIT_MS;
  const listPath = `${root}/actions/workflows/deploy.yml/runs?branch=test&event=push&head_sha=${head}&per_page=10`;
  let run;
  // A PR synchronize event may arrive before the test push appears in the API.
  while (!run && now() < indexUntil) {
    const list = await get(listPath);
    if (!Array.isArray(list?.workflow_runs)) throw new Error('Invalid GitHub workflow run response.');
    run = list.workflow_runs.slice(0, 10).find(matches);
    if (!run) await sleep(Math.max(0, Math.min(POLL_MS, indexUntil - now())));
  }
  if (!run) return null;

  const runId = run.id;
  const url = `https://github.com/${repository}/actions/runs/${runId}`;
  if (ACTIVE_STATES.has(run.status)) log(`Waiting for matching test push: ${url}`);
  while (ACTIVE_STATES.has(run.status) && now() < waitUntil) {
    await sleep(Math.max(0, Math.min(POLL_MS, waitUntil - now())));
    run = await get(`${root}/actions/runs/${runId}`);
    if (!matches(run) || run.id !== runId) throw new Error('GitHub returned a different workflow run while waiting.');
  }
  if (run.status !== 'completed') throw new Error(`Matching test push did not complete within the wait limit: ${url}`);
  if (run.conclusion !== 'success') {
    throw new Error(`Matching test push did not succeed: ${url}`);
  }
  const result = await verifyAttempt(root, run, { get, sleep, log });
  if (!result) throw new Error(`Could not verify every full validation and test deployment step for the matching test push: ${url}`);
  return result;
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_STEP_SUMMARY, GITHUB_EVENT_NAME, WAIT_TEST_HEAD } = process.env;
  if (!GH_TOKEN) throw new Error('Missing read-only GitHub token.');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', '--verify', 'HEAD');
  if (commit !== GITHUB_SHA) throw new Error('Checkout does not match the workflow event commit.');
  const tree = git('rev-parse', '--verify', 'HEAD^{tree}');
  const get = async (path, { allowMissing = false, budget } = {}) => {
    const requestLimit = AbortSignal.timeout(10_000);
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: budget ? AbortSignal.any([budget, requestLimit]) : requestLimit,
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
    return response.json();
  };
  const budget = AbortSignal.timeout(120_000);
  let result = await findTestValidation({
    repository: GITHUB_REPOSITORY, commit, tree,
    get: (path, options) => get(path, { ...options, budget }),
  });
  if (!result && GITHUB_EVENT_NAME === 'pull_request' && WAIT_TEST_HEAD) {
    result = await waitForTestPush({ repository: GITHUB_REPOSITORY, head: WAIT_TEST_HEAD, tree, get });
  }
  if (!result) {
    throw new Error(`No matching full test validation and test deployment for tree ${tree} among the last ${MAX_RUNS} successful test pushes. Run the full workflow on test for this exact tree (Chromium-only, skip, PR and manual runs do not qualify), then retry.`);
  }
  const url = `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${result.runId}/attempts/${result.runAttempt}`;
  const summary = `Verified tree \`${tree}\` against [full test push](${url}) (\`${result.testCommit}\`).`;
  console.log(summary);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tested_sha=${result.testCommit}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Production release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
