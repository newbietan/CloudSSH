import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { filterServers, type ServerConfig } from '../frontend/src/server-list';

const servers: ServerConfig[] = [
  {
    id: 1,
    user_id: 1,
    name: 'Production API',
    host: 'api.example.com',
    port: 22,
    username: 'deploy',
    auth_method: 'publickey',
    created_at: '',
    updated_at: '',
  },
  {
    id: 2,
    user_id: 1,
    name: '测试数据库',
    host: '10.0.0.8',
    port: 2222,
    username: 'DBAdmin',
    auth_method: 'password',
    created_at: '',
    updated_at: '',
  },
];

describe('服务器列表搜索', () => {
  it('按名称、主机和用户名进行不区分大小写的过滤', () => {
    expect(filterServers(servers, 'production')).toEqual([servers[0]]);
    expect(filterServers(servers, '10.0.0.8')).toEqual([servers[1]]);
    expect(filterServers(servers, 'dbadmin')).toEqual([servers[1]]);
  });

  it('忽略查询两端空白，空查询返回全部服务器', () => {
    expect(filterServers(servers, '  API  ')).toEqual([servers[0]]);
    expect(filterServers(servers, '   ')).toEqual(servers);
  });

  it('没有匹配项时返回空列表', () => {
    expect(filterServers(servers, 'missing')).toEqual([]);
  });
});

describe('Agent 危险确认交互', () => {
  const agentSource = readFileSync(
    new URL('../frontend/src/agent/agent-panel.ts', import.meta.url),
    'utf8',
  );
  const confirmDialogSource = agentSource.slice(
    agentSource.indexOf('private showConfirmDialog'),
    agentSource.indexOf('private convertStreamToThoughtStep'),
  );
  const tabManagerSource = readFileSync(
    new URL('../frontend/src/tab-manager.ts', import.meta.url),
    'utf8',
  );

  it('使用 alertdialog 语义并默认聚焦拒绝按钮', () => {
    expect(confirmDialogSource).toContain("el.setAttribute('role', 'alertdialog')");
    expect(confirmDialogSource).toContain("el.setAttribute('aria-labelledby', 'agent-confirm-title')");
    expect(confirmDialogSource).toContain("el.setAttribute('aria-describedby', 'agent-confirm-description')");
    expect(confirmDialogSource).toContain('requestAnimationFrame(() => rejectButton.focus())');
  });

  it('Escape 拒绝、Tab 限制焦点，且没有全局 Enter 批准逻辑', () => {
    expect(confirmDialogSource).toContain("event.key === 'Escape'");
    expect(confirmDialogSource).toContain("event.key !== 'Tab'");
    expect(confirmDialogSource).not.toContain("event.key === 'Enter'");
    expect(confirmDialogSource).toContain('this.resolvePendingConfirmation(false)');
  });

  it('关闭面板、销毁会话或切换标签时自动拒绝待确认操作', () => {
    expect(agentSource).toMatch(/hide\(\): void \{\s*this\.rejectPendingConfirmation\(false\)/);
    expect(agentSource).toMatch(/dispose\(\): void \{\s*this\.rejectPendingConfirmation\(false\)/);
    expect(tabManagerSource).toContain('prevTab.agentPanel?.rejectPendingConfirmation(false)');
  });
});
