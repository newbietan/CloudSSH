import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WORKFLOW = '.github/workflows/deploy.yml';
const TEST_JOB = 'Validate test';
const MAX_RUNS = 30;
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

/** Use GitHub-owned run/attempt metadata, not status labels, artifacts or executable files from test. */
export async function findTestValidation({ repository, commit, tree, get }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !isSha(commit) || !isSha(tree)) {
    throw new Error('Invalid repository or commit metadata.');
  }
  const root = `/repos/${repository}`;
  const data = await get(
    `${root}/actions/workflows/deploy.yml/runs?branch=test&event=push&status=success&per_page=${MAX_RUNS}`
  );
  if (!Array.isArray(data?.workflow_runs)) throw new Error('Invalid GitHub workflow run response.');
  const candidates = data.workflow_runs.slice(0, MAX_RUNS).filter(run =>
    run?.path === WORKFLOW && run.event === 'push' && run.head_branch === 'test' &&
    run.status === 'completed' && run.conclusion === 'success' &&
    sameRepo(run.repository, repository) && sameRepo(run.head_repository, repository) &&
    isSha(run.head_sha) && isId(run.id) && isId(run.run_attempt)
  );
  const trees = new Map([[commit, tree]]);
  // Exact commit matches are common after syncing branches. Squashes can use a different SHA.
  candidates.sort((a, b) => Number(b.head_sha === commit) - Number(a.head_sha === commit));
  for (const run of candidates) {
    if (!trees.has(run.head_sha)) {
      const info = await get(`${root}/git/commits/${run.head_sha}`, { allowMissing: true });
      if (info !== null && (info?.sha !== run.head_sha || !isSha(info?.tree?.sha))) {
        throw new Error('Invalid GitHub Git commit response.');
      }
      trees.set(run.head_sha, info?.tree.sha ?? null);
    }
    if (trees.get(run.head_sha) !== tree) continue;

    const attempt = await get(`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=20`);
    if (!Array.isArray(attempt?.jobs)) throw new Error('Invalid GitHub workflow job response.');
    const job = attempt.jobs.find(item => item?.name === TEST_JOB && item.run_id === run.id &&
      item.run_attempt === run.run_attempt && item.head_sha === run.head_sha);
    if (job?.status !== 'completed' || job.conclusion !== 'success' || !Array.isArray(job.steps)) continue;
    const passed = new Set(job.steps.filter(step =>
      step?.status === 'completed' && step.conclusion === 'success'
    ).map(step => step.name));
    if (REQUIRED_STEPS.every(name => passed.has(name))) {
      return { runId: run.id, runAttempt: run.run_attempt, testCommit: run.head_sha };
    }
  }
  return null;
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_STEP_SUMMARY } = process.env;
  if (!GH_TOKEN) throw new Error('Missing read-only GitHub token.');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', '--verify', 'HEAD');
  if (commit !== GITHUB_SHA) throw new Error('Checkout does not match the workflow event commit.');
  const tree = git('rev-parse', '--verify', 'HEAD^{tree}');
  const budget = AbortSignal.timeout(120_000);
  const get = async (path, { allowMissing = false } = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.any([budget, AbortSignal.timeout(10_000)]),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
    return response.json();
  };
  const result = await findTestValidation({ repository: GITHUB_REPOSITORY, commit, tree, get });
  if (!result) {
    throw new Error(`No matching full test validation and test deployment for tree ${tree} among the last ${MAX_RUNS} successful test pushes. Run the full workflow on test for this exact tree (Chromium-only, skip, PR and manual runs do not qualify), then retry.`);
  }
  const url = `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${result.runId}/attempts/${result.runAttempt}`;
  const summary = `Verified tree \`${tree}\` against [full test push](${url}) (\`${result.testCommit}\`).`;
  console.log(summary);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Production release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
