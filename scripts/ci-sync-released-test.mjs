// Post-deploy only. Read immutable release evidence; write just refs/heads/test once.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = 'newbietan/CloudSSH';
const MAIN = 'refs/heads/main';
const TEST = 'refs/heads/test';
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s) && !/^0+$/.test(s);
const ourRepo = (s) => typeof s === 'string' && s.toLowerCase() === REPO.toLowerCase();

export function releaseGit(remote, cwd = process.cwd()) {
  function git(...args) {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).trim();
    } catch {
      throw new Error('Git command failed. Check repository access and branch rules.');
    }
  }
  // No token in URLs/arguments, no persisted credentials or fallback to a personal helper.
  const network = (...args) => git(
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'http.followRedirects=false', ...args
  );
  return {
    head: () => git('rev-parse', '--verify', 'HEAD'),
    tree: () => git('rev-parse', '--verify', 'HEAD^{tree}'),
    refs() {
      const refs = new Map();
      const output = network('ls-remote', '--refs', remote, MAIN, TEST);
      for (const line of output ? output.split('\n') : []) {
        const [sha, name] = line.split('\t');
        if (!isSha(sha) || ![MAIN, TEST].includes(name) || refs.has(name)) {
          throw new Error('Invalid remote branch response.');
        }
        refs.set(name, sha);
      }
      return { main: refs.get(MAIN), test: refs.get(TEST) };
    },
    push(release, tested) {
      network(
        'push', '--no-follow-tags', `--force-with-lease=${TEST}:${tested}`, remote, `${release}:${TEST}`
      );
    },
  };
}

function skipForRefs(refs, release, tested) {
  if (refs.main !== release) return 'Skipped: main is no longer at the deployed commit.';
  if (refs.test === release) return 'No change: test already points to the deployed commit.';
  if (refs.test !== tested) return 'Skipped: test moved or was deleted; its history was preserved.';
  return null;
}

export async function syncReleasedTest({ release, tested, git, get }) {
  if (!isSha(release) || !isSha(tested) || git.head() !== release) {
    throw new Error('Invalid deployment checkout or missing verified test SHA.');
  }
  const pulls = await get(`commits/${release}/pulls?per_page=100`);
  if (!Array.isArray(pulls)) throw new Error('Invalid associated PR response.');
  const merged = pulls.filter(pr =>
    pr?.state === 'closed' && typeof pr.merged_at === 'string' && pr.merged_at.length > 0 &&
    pr.merge_commit_sha === release && pr.base?.ref === 'main' && pr.head?.ref === 'test' &&
    ourRepo(pr.base.repo?.full_name) && ourRepo(pr.head.repo?.full_name)
  );
  // Never infer a lease from the live branch or from an ambiguous/truncated PR list.
  if (pulls.length >= 100 || merged.length !== 1 || merged[0].head.sha !== tested) {
    return 'Skipped: no unique merged test → main PR with the exact verified test head.';
  }
  const source = await get(`git/commits/${tested}`);
  if (source?.sha !== tested || !isSha(source?.tree?.sha)) {
    throw new Error('Invalid test commit response.');
  }
  if (git.tree() !== source.tree.sha) {
    return 'Skipped: the verified PR head and deployed commit have different trees.';
  }

  const skip = skipForRefs(git.refs(), release, tested);
  if (skip) return skip;
  try {
    git.push(release, tested);
  } catch {
    // A concurrent push can win after ls-remote. Only observe; never retry with a fresh lease.
    const changed = skipForRefs(git.refs(), release, tested);
    if (changed) return changed;
    throw new Error('Check token permissions and branch rules; no push was retried.');
  }
  return `Aligned test from ${tested} to deployed main ${release}.`;
}

async function main() {
  const env = process.env;
  if (!ourRepo(env.GITHUB_REPOSITORY) || env.GITHUB_EVENT_NAME !== 'push' ||
      env.GITHUB_REF !== MAIN || !env.GH_TOKEN) {
    throw new Error('Expected a production push job token.');
  }
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
    return response.json();
  };
  const message = await syncReleasedTest({
    release: env.GITHUB_SHA, tested: env.TESTED_SHA, git: releaseGit(`https://github.com/${REPO}.git`), get,
  });
  console.log(message);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Post-deploy branch sync failed (production already deployed): ${error.message}`);
    process.exitCode = 1;
  }
}
