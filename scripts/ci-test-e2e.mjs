import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function resolveE2eProfile(event, ref, requested) {
  if (event !== 'push' || ref !== 'refs/heads/test') return { profile: 'full', invalid: false };
  if (requested === 'chromium' || requested === 'skip') return { profile: requested, invalid: false };
  return { profile: 'full', invalid: !!requested && requested !== 'full' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { profile, invalid } = resolveE2eProfile(
    process.env.GITHUB_EVENT_NAME,
    process.env.GITHUB_REF,
    process.env.TEST_E2E_PROFILE
  );
  if (invalid) console.warn('::warning::Unsupported CLOUDSSH_TEST_E2E value. Running full browser checks.');
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
