import { describe, it, expect } from 'vitest';
import { isBlockedCommand, needsConfirmation } from '../../../src/worker/agent/safety';

// =====================================================================
// safety.test.ts
// ---------------------------------------------------------------
// 这两个模块是 CloudSSH AI Agent 的两层安全防线：
//   - isBlockedCommand：硬拦截，无论用户意图都拒绝
//   - needsConfirmation：高风险命令，弹窗确认后才执行
// 一旦拦截规则被无意修改而产生 bypass 或过严回归，后果严重，
// 所以这里用回归测试把每条规则的语义固化下来。
// 对每条规则既测"应该命中"的正例，也测"看起来像但不该命中"的负担例，
// 防止正则过严或过松这两个方向的退化。
// =====================================================================

describe('safety — isBlockedCommand', () => {
  // ----- 基础语义 -----
  it('对普通命令应返回 blocked=false 且无 reason', () => {
    const cases = [
      'ls -la',
      'cat /etc/nginx/nginx.conf',
      'df -h',
      'echo hello world',
      'systemctl status nginx',
      'docker ps',
    ];
    for (const cmd of cases) {
      const r = isBlockedCommand(cmd);
      expect(r.blocked, `cmd="${cmd}"`).toBe(false);
      expect(r.reason, `cmd="${cmd}"`).toBeUndefined();
    }
  });

  // ----- rm -rf / 及其变体 -----
  describe('rm -rf / 删除根目录', () => {
    it('应拦截 rm -rf /', () => {
      expect(isBlockedCommand('rm -rf /').blocked).toBe(true);
    });
    it('应拦截以斜杠结尾的 rm -rf /', () => {
      expect(isBlockedCommand('rm -rf / ').blocked).toBe(true);
      expect(isBlockedCommand('rm -rf /tmp').blocked).toBe(false); // /tmp 是合法目录，不应被此规则拦截
    });
    it('应拦截 rm -rf //（双斜杠）', () => {
      expect(isBlockedCommand('rm -rf //').blocked).toBe(true);
    });
    it('应拦截 rm -rf -- 多空格变体', () => {
      expect(isBlockedCommand('rm  -rf  /').blocked).toBe(true);
      expect(isBlockedCommand('rm   -rf   / ').blocked).toBe(true);
    });
    it('应拦截 rm -递归flag 组合（rm -fr /）', () => {
      expect(isBlockedCommand('rm -fr /').blocked).toBe(true);
    });
    it('应拦截 sudo rm -rf /', () => {
      expect(isBlockedCommand('sudo rm -rf /').blocked).toBe(true);
    });
  });

  // ----- 路径遍历类（~/../ or /../ ） -----
  describe('路径遍历删除', () => {
    it('应拦截 rm -rf ~/..（路径上跳到 home 父级）', () => {
      expect(isBlockedCommand('rm -rf ~/../').blocked).toBe(true);
    });
    it('应拦截 rm -rf /.. 路径遍历', () => {
      expect(isBlockedCommand('rm -rf /../').blocked).toBe(true);
    });
  });

  // ----- 磁盘覆写 / 格式化 -----
  describe('磁盘设备破坏', () => {
    it('应拦截 dd if=/dev/zero of=/dev/sda', () => {
      expect(isBlockedCommand('dd if=/dev/zero of=/dev/sda').blocked).toBe(true);
    });
    it('应拦截 dd if=/dev/random of=/dev/nvme0n2', () => {
      expect(isBlockedCommand('dd if=/dev/random of=/dev/nvme0n2').blocked).toBe(true);
    });
    it('应拦截 dd if=/dev/urandom of=/dev/vda', () => {
      expect(isBlockedCommand('dd if=/dev/urandom of=/dev/vda').blocked).toBe(true);
    });
    it('不应拦截写入普通文件的 dd（if不是zero/random）', () => {
      // 此规则只针对 zero/random/urandom → 块设备的写，合法 dd 不应被此规则命中
      expect(isBlockedCommand('dd if=image.iso of=disk.img').blocked).toBe(false);
    });
    it('应拦截 mkfs.ext4 /dev/sda1', () => {
      expect(isBlockedCommand('mkfs.ext4 /dev/sda1').blocked).toBe(true);
    });
    it('应拦截 mkfs.xfs /dev/nvme0n1p2', () => {
      expect(isBlockedCommand('mkfs.xfs /dev/nvme0n1p2').blocked).toBe(true);
    });
    it('应拦截写入块设备（> /dev/sda）', () => {
      expect(isBlockedCommand('echo bad > /dev/sda').blocked).toBe(true);
    });
  });

  // ----- fork bomb -----
  describe('fork bomb', () => {
    it('应拦截经典 fork bomb :(){:|:&};:', () => {
      expect(isBlockedCommand(':(){:|:&};:').blocked).toBe(true);
    });
  });

  // ----- 批量改密 -----
  describe('批量修改密码', () => {
    it('应拦截 chpasswd（批量改密工具）', () => {
      expect(isBlockedCommand('echo "user:pass" | chpasswd').blocked).toBe(true);
    });
    // 注意：passwd 单条改密走 confirm 规则，不在此处
    it('不应拦截单独的 passwd 命令（由 needsConfirmation 处理）', () => {
      expect(isBlockedCommand('passwd root').blocked).toBe(false);
    });
  });

  // ----- find -delete / -exec rm / xargs rm -----
  describe('递归删除变种', () => {
    it('应拦截 find / -delete', () => {
      expect(isBlockedCommand('find / -delete').blocked).toBe(true);
    });
    it('应拦截 find . -exec rm -rf {} +', () => {
      expect(isBlockedCommand('find . -exec rm -rf {} +').blocked).toBe(true);
    });
    it('应拦截 find -name xxx -exec rm -rf {} \\;', () => {
      expect(isBlockedCommand('find /var/log -name "*.log" -exec rm -rf {} \\;').blocked).toBe(true);
    });
    it('应拦截 xargs rm', () => {
      expect(isBlockedCommand('ls | xargs rm').blocked).toBe(true);
    });
    it('应拦截 xargs rm -rf', () => {
      expect(isBlockedCommand('find . -type f | xargs rm -rf').blocked).toBe(true);
    });
    // 误报防护：find 不带删除动作不应被拦截
    it('不应拦截纯查找的 find', () => {
      expect(isBlockedCommand('find . -name "*.ts"').blocked).toBe(false);
    });
    it('不应拦截 find -name 只做打印', () => {
      expect(isBlockedCommand('find . -name "*.log" -print').blocked).toBe(false);
    });
  });

  // ----- reason 字段格式 -----
  it('拦截时应返回中文 reason', () => {
    const r = isBlockedCommand('rm -rf /');
    expect(r.reason).toBeTruthy();
    expect(typeof r.reason).toBe('string');
    // 实际文案为"此操作已被禁止：删除根目录"
    expect(r.reason).toContain('已被禁止');
  });
});

describe('safety — needsConfirmation', () => {
  // ----- 基础语义 -----
  it('对普通命令应返回 required=false', () => {
    for (const cmd of ['ls -la', 'cat /etc/hosts', 'df -h', 'uptime', 'uname -a']) {
      expect(needsConfirmation(cmd).required, `cmd="${cmd}"`).toBe(false);
    }
  });

  // ----- 被硬拦截的命令不进入 confirm 流程 -----
  it('被 blocked 的命令 needsConfirmation 返回 required=false（因为已被硬拒）', () => {
    expect(needsConfirmation('rm -rf /').required).toBe(false);
    expect(needsConfirmation(':(){:|:&};:').required).toBe(false);
  });

  // ----- rm -rf 确认规则 -----
  describe('rm -rf 确认', () => {
    it('应要求确认 rm -rf some_dir', () => {
      const r = needsConfirmation('rm -rf /tmp/some_dir');
      expect(r.required).toBe(true);
      expect(r.reason).toBeTruthy();
    });
    it('应要求确认带 sudo 的 rm -rf', () => {
      expect(needsConfirmation('sudo rm -rf /var/log/app').required).toBe(true);
    });
    it('rm 不带 -rf 但带路径（削根级路径）仍要求确认', () => {
      expect(needsConfirmation('rm -r /tmp/foo').required).toBe(true);
    });
    it('rm 单文件无 -rf 时不触发 rm 相关确认（不被任何 confirm 规则命中）', () => {
      // 仅删除一个普通文件且无危险 flag，不应被 CONFIRM_PATTERNS 中 rm 规则命中
      expect(needsConfirmation('rm file.txt').required).toBe(false);
    });
  });

  // ----- 关机/重启 -----
  describe('关机重启', () => {
    for (const cmd of ['shutdown -h now', 'reboot', 'halt', 'poweroff']) {
      it(`应要求确认 ${cmd}`, () => {
        const r = needsConfirmation(cmd);
        expect(r.required).toBe(true);
        expect(r.reason).toContain('重启');
      });
    }
  });

  // ----- dd / mkfs 确认 -----
  describe('dd / mkfs 确认', () => {
    it('应要求确认 dd if=image.iso of=/dev/sdb（写盘）', () => {
      expect(needsConfirmation('dd if=image.iso of=/dev/sdb').required).toBe(true);
    });
    it('mkfs.ext4 /dev/sdc1 已被 BLOCKED 硬拦截，needsConfirmation 短路返回 false', () => {
      // mkfs /dev/sdX 在 BLOCKED_PATTERNS 中无条件拒绝，
      // needsConfirmation 看到 blocked 就不再要求确认（由调用方直接拒绝）。
      expect(isBlockedCommand('mkfs.ext4 /dev/sdc1').blocked).toBe(true);
      expect(needsConfirmation('mkfs.ext4 /dev/sdc1').required).toBe(false);
    });
    it('应要求确认 mkfs 对非块设备路径（如镜像文件）', () => {
      // 写到非块设备（image disk.img 等）不会被 BLOCKED 拦截，
      // 但仍触发 CONFIRM_PATTERNS 中 mkfs 的弹窗确认规则。
      expect(needsConfirmation('mkfs.ext4 disk.img').required).toBe(true);
    });
  });

  // ----- 权限和属主修改 -----
  describe('chmod / chown', () => {
    it('应要求确认 chmod -R 777 /var/www（权限全开）', () => {
      expect(needsConfirmation('chmod -R 777 /var/www').required).toBe(true);
    });
    it('应要求确认 chmod 777 file（即使不带 -R）', () => {
      expect(needsConfirmation('chmod 777 somefile').required).toBe(true);
    });
    it('应要求确认 chown -R root /var/www', () => {
      expect(needsConfirmation('chown -R root /var/www').required).toBe(true);
    });
    it('不应拦截 chmod 644 file（普通权限调整）', () => {
      expect(needsConfirmation('chmod 644 file.txt').required).toBe(false);
    });
    it('应要求确认 chmod +s（设置 SUID）', () => {
      expect(needsConfirmation('chmod +s /usr/bin/binary').required).toBe(true);
    });
  });

  // ----- 防火墙 -----
  describe('防火墙修改', () => {
    it('应要求确认 iptables -F（清空规则）', () => {
      expect(needsConfirmation('iptables -F').required).toBe(true);
    });
    it('应要求确认 iptables -P INPUT DROP（默认策略置 DROP）', () => {
      expect(needsConfirmation('iptables -P INPUT DROP').required).toBe(true);
    });
    it('应要求确认 ufw disable', () => {
      expect(needsConfirmation('ufw disable').required).toBe(true);
    });
    it('应要求确认 firewall-cmd --panic-on', () => {
      expect(needsConfirmation('firewall-cmd --panic-on').required).toBe(true);
    });
    it('不应拦截 iptables -L（查看规则）', () => {
      expect(needsConfirmation('iptables -L -n').required).toBe(false);
    });
    it('不应拦截 ufw status（查看状态）', () => {
      expect(needsConfirmation('ufw status').required).toBe(false);
    });
  });

  // ----- 远程脚本执行 -----
  describe('远程脚本执行', () => {
    it('应要求确认 wget ... | sh', () => {
      expect(needsConfirmation('wget https://example.com/install.sh | sh').required).toBe(true);
    });
    it('应要求确认 curl ... | bash', () => {
      expect(needsConfirmation('curl https://example.com/install.sh | bash').required).toBe(true);
    });
    it('不应拦截单纯 curl 下载（无管道到 shell）', () => {
      expect(needsConfirmation('curl -o file.tar.gz https://example.com/x.tar.gz').required).toBe(false);
    });
  });

  // ----- passwd 单条改密 -----
  describe('passwd 命令', () => {
    it('应要求确认 passwd root', () => {
      expect(needsConfirmation('passwd root').required).toBe(true);
    });
    it('应要求确认 passwd（修改当前用户密码）', () => {
      expect(needsConfirmation('passwd').required).toBe(true);
    });
  });

  // ----- 包管理器 -----
  describe('包管理器安装/卸载/升级', () => {
    for (const cmd of [
      'apt install nginx',
      'apt remove apache2',
      'apt purge old-package',
      'apt update',
      'apt upgrade',
      'yum install httpd',
      'yum remove postfix',
      'dnf install nodejs',
      'apk add curl',
      'apk del openssl',
    ]) {
      it(`应要求确认 ${cmd}`, () => {
        expect(needsConfirmation(cmd).required).toBe(true);
      });
    }
    // 仅查询不应触发确认
    it('不应拦截 apt list --installed（只查询）', () => {
      expect(needsConfirmation('apt list --installed').required).toBe(false);
    });
    it('不应拦截 dpkg -l（列出已装包）', () => {
      expect(needsConfirmation('dpkg -l').required).toBe(false);
    });
  });

  // ----- sudo 分级 -----
  describe('sudo 分级处理', () => {
    // 安全的只读 sudo —— 免确认
    it('sudo systemctl status 免确认', () => {
      expect(needsConfirmation('sudo systemctl status nginx').required).toBe(false);
    });
    it('sudo systemctl is-active 免确认', () => {
      expect(needsConfirmation('sudo systemctl is-active docker').required).toBe(false);
    });
    it('sudo ss -tlnp 免确认', () => {
      expect(needsConfirmation('sudo ss -tlnp').required).toBe(false);
    });
    it('sudo docker ps 免确认', () => {
      expect(needsConfirmation('sudo docker ps').required).toBe(false);
    });
    it('sudo journalctl -u nginx 免确认', () => {
      expect(needsConfirmation('sudo journalctl -u nginx').required).toBe(false);
    });

    // systemd 服务写操作 —— 安全策略上 start/restart/enable 免确认（已有专门 service_manage 工具承载）
    it('sudo systemctl start nginx 免确认', () => {
      expect(needsConfirmation('sudo systemctl start nginx').required).toBe(false);
    });
    it('sudo systemctl restart nginx 免确认', () => {
      expect(needsConfirmation('sudo systemctl restart nginx').required).toBe(false);
    });

    // sudo 写操作 —— 必须确认
    it('sudo systemctl stop nginx 要求确认', () => {
      expect(needsConfirmation('sudo systemctl stop nginx').required).toBe(true);
    });
    it('sudo systemctl disable nginx 要求确认', () => {
      expect(needsConfirmation('sudo systemctl disable nginx').required).toBe(true);
    });
    it('sudo docker stop web 要求确认', () => {
      expect(needsConfirmation('sudo docker stop web').required).toBe(true);
    });
    it('sudo docker rm web 要求确认', () => {
      expect(needsConfirmation('sudo docker rm web').required).toBe(true);
    });
    it('sudo useradd deploy 要求确认', () => {
      expect(needsConfirmation('sudo useradd deploy').required).toBe(true);
    });
    it('sudo usermod -aG docker app 要求确认', () => {
      expect(needsConfirmation('sudo usermod -aG docker app').required).toBe(true);
    });
    it('sudo crontab -e 要求确认', () => {
      expect(needsConfirmation('sudo crontab -e').required).toBe(true);
    });
    it('sudo mount /dev/sda1 /mnt 要求确认', () => {
      expect(needsConfirmation('sudo mount /dev/sda1 /mnt').required).toBe(true);
    });

    // 未知 sudo（不在白名单也不在写操作列表）—— 兜底要求确认
    it('sudo rm /etc/passwd 兜底要求确认（未知 sudo 命令）', () => {
      expect(needsConfirmation('sudo rm /etc/passwd').required).toBe(true);
    });
    it('sudo some-custom-binary --force 兜底要求确认', () => {
      expect(needsConfirmation('sudo some-custom-binary --force').required).toBe(true);
    });
  });

  // ----- reason 字段格式 -----
  it('需要确认时应返回非空中文 reason', () => {
    const r = needsConfirmation('rm -rf /tmp/foo');
    expect(r.required).toBe(true);
    expect(typeof r.reason).toBe('string');
    expect(r.reason!.length).toBeGreaterThan(0);
  });
});
