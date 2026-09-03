import { describe, expect, it } from 'vitest';
import {
  extractSnippetVariables,
  resolveSnippetVariables,
} from '../frontend/src/snippet-variables';

describe('命令片段参数占位符提取 (extractSnippetVariables)', () => {
  it('提取单个参数占位符', () => {
    expect(extractSnippetVariables('docker logs -f {{container}}')).toEqual(['container']);
  });

  it('提取多个参数占位符并保持出现顺序', () => {
    expect(
      extractSnippetVariables('curl -u {{username}}:{{password}} https://{{host}}:{{port}}')
    ).toEqual(['username', 'password', 'host', 'port']);
  });

  it('重复出现的占位符去重', () => {
    expect(
      extractSnippetVariables('echo "deploying {{app}}" && docker restart {{app}}')
    ).toEqual(['app']);
  });

  it('容忍花括号内的前后空格', () => {
    expect(extractSnippetVariables('tail -f {{ log_file }}')).toEqual(['log_file']);
  });

  it('支持中文字符等变量名', () => {
    expect(extractSnippetVariables('systemctl restart {{服务名称}}')).toEqual(['服务名称']);
  });

  it('无占位符的普通命令返回空数组', () => {
    expect(extractSnippetVariables('df -h && free -m')).toEqual([]);
    expect(extractSnippetVariables('echo "{not_a_variable}"')).toEqual([]);
  });
});

describe('命令片段参数替换 (resolveSnippetVariables)', () => {
  it('按提供的键值字典替换全部占位符', () => {
    const template = 'docker run -d --name {{name}} -p {{port}}:80 {{image}}';
    const resolved = resolveSnippetVariables(template, {
      name: 'web-app',
      port: '8080',
      image: 'nginx:alpine',
    });
    expect(resolved).toBe('docker run -d --name web-app -p 8080:80 nginx:alpine');
  });

  it('同一变量出现多次时全部替换', () => {
    const template = 'echo {{target}} && ping {{target}}';
    const resolved = resolveSnippetVariables(template, { target: '1.1.1.1' });
    expect(resolved).toBe('echo 1.1.1.1 && ping 1.1.1.1');
  });

  it('未提供对应值的占位符保留原样', () => {
    const template = 'scp {{file}} {{user}}@{{host}}:/tmp';
    const resolved = resolveSnippetVariables(template, { file: 'app.tar.gz' });
    expect(resolved).toBe('scp app.tar.gz {{user}}@{{host}}:/tmp');
  });
});
