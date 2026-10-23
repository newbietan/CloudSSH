import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
const readWorkflow = (file: string) =>
  readFileSync(new URL(file, workflowDir), 'utf8').replace(/\r\n/g, '\n');

describe('Fork 工作流执行策略', () => {
  // This source-level contract checks every job, including future workflows.
  // A step-level guard is too late: it would still allocate a runner/matrix.
  it.each(workflows.filter((file) => file !== 'sync-upstream.yml'))(
    '%s 的所有 job 仅在维护者仓库中执行',
    (file) => {
      const jobs = readWorkflow(file).split('\njobs:\n')[1] ?? '';
      const jobHeaders = jobs.match(/^  [\w-]+:$/gm) ?? [];
      const ownerGuards = jobs.match(/^    if: github\.repository_owner == 'newbietan'$/gm) ?? [];
      expect(jobHeaders.length).toBeGreaterThan(0);
      expect(ownerGuards).toHaveLength(jobHeaders.length);
    }
  );

  it('Fork 可直接手动同步，定时同步需要显式开启', () => {
    const sync = readWorkflow('sync-upstream.yml');
    expect(sync).toMatch(/^  workflow_dispatch:$/m);
    expect(sync).toMatch(/^  schedule:$/m);
    expect(sync).toContain(
      `    if: >-
      github.event.repository.fork == true &&
      (github.event_name == 'workflow_dispatch' || vars.AUTO_SYNC_UPSTREAM == 'true')
`
    );
    expect(sync).toContain('"repos/${REPOSITORY}/merge-upstream"');
    expect(sync).toContain('-f branch=main');
    expect(sync).not.toContain('secrets.');
  });
});
