# 图标与字体本地化

## 适用版本与范围

自 CloudSSH v2.10.3 起，字体与图标随项目分发，沿用单 HTML 构建方式；无需更改认证方式、Durable Object 绑定或迁移。

- Worker 主站的 Material Symbols Outlined 图标、JetBrains Mono 字体全部来自仓库文件，最终以内联 data URL 随 HTML 返回。
- 独立主题编辑器改用 `docs/theme-editor/fonts/` 中的同源字体，构建时由 `scripts/sync-theme-editor.js` 同步。
- favicon、操作系统 SVG 等已有本地图标保持不变。
- 这不是“整个应用离线化”：Turnstile、人机验证、GitHub OAuth/用户头像、AI Markdown 中的用户图片、SSH/AI 请求等仍按原有功能访问网络。
- 主站的“主题编辑器”按钮仍指向上游 Pages 站点；本次修改的是仓库中的编辑器副本，不会自动改变上游站点。自行发布该编辑器后，可按实际地址修改 `frontend/src/custom-theme-manager.ts` 中的链接。

## 为什么需要内联

Cloudflare Workers 支持静态资源托管，但本项目没有配置静态资源绑定。本次沿用单 HTML 的现有结构，不新增资源路由。`scripts/build-html.js` 仅把 JS、CSS、favicon 写进 `src/worker/html.ts`，不会为字体文件提供 HTTP 路由。字体因此放在 `frontend/src/assets/fonts/`，通过 Vite 的定向 `assetsInlineLimit` 回调强制变成 CSS 内的 data URL，不受文件大小阈值影响；其他资源仍使用默认阈值，不必新增静态路由、R2 或 KV。构建脚本会在写入 HTML 前校验两个字体的完整字节、拒绝独立字体产物和外部 font-face URL，异常即终止构建。

`src/worker/html.ts` 是生成文件，不要手工修改。本仓库当前实际跟踪了该文件；重新构建后它会产生相应变更。只检查此文件的 gzip 大小不能代表整个 Worker 的上传大小，必须额外运行 Wrangler dry-run。

## 图标覆盖与加载取舍

维护脚本保守扫描两套应用的 HTML/TS/JS 词元，与上游实际连字名称求交集（包含动态使用、别名与少量保守多纳入项），再校验裁剪后的真实连字表。普通 Vitest 通过生成的名称目录与字体 SHA-256 检查新增图标是否已纳入。

内联字体会增加 HTML 的传输大小，换取不依赖第三方字体服务的稳定加载；不能仅用 HTML 大小判断旧 CDN 方案与本地方案的端到端速度。JetBrains Mono 保留 latin 子集，其他字符继续使用系统字体回退。

## 构建与验证

使用仓库指定的 Node.js 22、pnpm 11.8.0 和锁文件：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build:frontend
pnpm exec playwright install chromium webkit
pnpm run test:e2e
pnpm exec wrangler deploy --dry-run --env="" --outdir .cache/worker-dry-run
```

`tests/e2e/local-fonts.spec.ts` 在 Chromium 和 WebKit 移动端核验开发页、实际生成的 Worker HTML，以及按真实目录映射的 Pages 编辑器与字体资源。覆盖全部清单连字、字重、FILL 图形变化、无 Google Fonts 请求与 Worker 不请求独立字体资源；字体族断言允许浏览器序列化引号的差异。运行这些 E2E 前须先执行 `build:frontend`，避免验证过期的生成 HTML。

若机器较慢，可降低 Vitest/Playwright 并发：

```bash
pnpm test --maxWorkers=4
pnpm exec playwright test --workers=2
```

测试时将 `XDG_CACHE_HOME`、`npm_config_cache`、`PIP_CACHE_DIR`、`PYTHONPYCACHEPREFIX`、`TMPDIR`、`PLAYWRIGHT_BROWSERS_PATH` 指向项目内 `.cache/` 的对应子目录，pnpm 安装使用 `--store-dir .cache/pnpm-store`；不要把本地缓存或浏览器运行时提交到仓库。

## 部署到已有 Worker

**不要删除已有 Worker，不要修改已有 Durable Object 绑定或 migration tag。**

### Cloudflare Dashboard Git 集成

- 必须使用你已有 Worker 关联的 Git 仓库、生产分支和已有构建变量/Secrets。
- 安装：`pnpm install --frozen-lockfile`。
- 构建：`pnpm run build:frontend`。
- 部署：`pnpm exec wrangler deploy --env=""`（默认生产配置）；也可使用包含构建的 `pnpm run deploy`，不要与前一步重复构建。
- `wrangler.toml` 普通 `[vars]` 会按配置重新下发，先确认与你的现有设置一致；保留原有 Secrets。

官方 GitHub Actions 部署工作流要求 `github.repository_owner == 'newbietan'`，其他所有者的 Fork 不执行部署任务。不要为了字体改动移除该限制；Cloudflare Dashboard Git 集成与这些 Actions 是两套独立机制。

遵循仓库约定，改动放在 `test` 分支，生产 `main` 由用户审核 PR 后合入。若 Cloudflare 绑定的是 `main`，只推送 `test` 不会更新生产站点。

### 已登录本机 Wrangler

```bash
pnpm exec wrangler whoami
pnpm run deploy
```

本地构建/dry-run 成功不代表生产部署成功；实际部署仍需账号持有人的 Cloudflare 授权或已有 Dashboard Git 集成。

## 新增图标后如何更新

正常构建不下载字体，也不需要 Python。只有新增图标需要重新裁剪：

```bash
python3 -m venv .cache/font-venv
PIP_CACHE_DIR="$PWD/.cache/pip" .cache/font-venv/bin/python -m pip install fonttools==4.68.0 brotli==1.2.1
PYTHONPYCACHEPREFIX="$PWD/.cache/python" .cache/font-venv/bin/python scripts/subset-material-symbols.py
PYTHONPYCACHEPREFIX="$PWD/.cache/python" .cache/font-venv/bin/python scripts/subset-material-symbols.py --check
pnpm run sync:theme-editor
pnpm run build:frontend
```

脚本固定 Material Symbols 的上游版本 URL 与 SHA-256，并支持 `--source <本地完整字体>` 离线再生成。更新字体版本时必须先审查并更新脚本中的固定 URL/哈希，再重新生成；保留 `FILL` 和 `wght` 可变轴。

同时提交源字体、`material-symbols.json`、同步后的编辑器字体与相关源码；构建时不需要联网访问 Google Fonts。完整名称目录只供开发测试使用，不会进入前端包。

## 字体来源与许可

- Material Symbols Outlined：Google 官方 Google Fonts WOFF2 v383；上游来源 URL 与 SHA-256 在脚本/清单中。Apache-2.0，完整文本在 `Material-Symbols-LICENSE.txt`；裁剪文件保留字体名称/版权元数据。
- JetBrains Mono：Google Fonts v24 latin 可变字体，400–800。来源：`https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2`。
  SHA-256：`83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be`。SIL OFL-1.1，完整文本在 `JetBrains-Mono-OFL.txt`；字节已核对与官方来源一致。
