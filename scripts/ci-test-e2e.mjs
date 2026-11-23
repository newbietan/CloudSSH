import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const markerTitle = 'ci: 设置本次 test 推送的浏览器测试';
export const markerMessage = (profile) => `${markerTitle}\n\nCloudSSH-Test-E2E: ${profile}`;

function getProfile() {
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/test') {
    return 'full';
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const message = git('log', '-1', '--format=%B');
  const profile = ['chromium', 'skip'].find((value) => message === markerMessage(value));
  if (!profile) return 'full';

  // An exact marker is only valid as a one-parent empty commit. Never reduce checks
  // because a regular commit or a PR merge happens to contain the marker text.
  const parents = git('log', '-1', '--format=%P').split(' ');
  if (parents.length !== 1 || !parents[0]) return 'full';
  const parentTree = git('rev-parse', '--verify', `${parents[0]}^{tree}`);
  return parentTree === git('rev-parse', 'HEAD^{tree}') ? profile : 'full';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let profile = 'full';
  try {
    profile = getProfile();
  } catch {
    console.warn('::warning::Could not verify the test push marker; running full browser checks.');
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `profile=${profile}\n`);

  const labels = {
    full: 'Full: Chromium and mobile WebKit',
    chromium: 'Test-only: Chromium; mobile WebKit not run',
    skip: 'Test-only: browser checks not run',
  };
  const summary = `Browser validation: ${labels[profile]}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
