<div align="center">
  <img src="./logo.svg" alt="CloudSSH" width="480">
  <p>A Serverless Web SSH Terminal built on Cloudflare Workers: Connect and manage your servers directly from the browser.</p>
  <p><b>Ultra-lightweight · Out-of-the-box · Cyberpunk UI</b></p>
  <p>
    <a href="https://github.com/newbietan/CloudSSH/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/newbietan/CloudSSH?style=flat&logo=github"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg"></a>
    <img alt="Cloudflare" src="https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white">
    <img alt="Vite" src="https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white">
  </p>
  <p>
    <a href="#highlights">Highlights</a> ·
    <a href="#features">Features</a> ·
    <a href="#quick-start">Deployment</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="#contributors">Contributors</a> ·
    <a href="#license">License</a>
  </p>
  <p>
    <a href="README.md">简体中文</a> |
    <a href="README_en.md">English</a>
  </p>
</div>

> [!TIP]
> **CloudSSH** utilizes Cloudflare Workers' TCP Sockets support to handle SSH protocol parsing and forwarding at edge nodes, providing a low-latency Web Terminal experience.

## Demo

> Imagine opening your browser anytime, anywhere, and connecting to your server with a highly futuristic cyberpunk UI, without installing any SSH client.

<div align="center">
  <a href="https://www.bilibili.com/video/BV1UgMt6UEdF" target="_blank" title="Click to play video">
    <img src="https://i1.hdslb.com/bfs/archive/28a55cf05e4b5608e7ee0345b043e7ea97c81ed7.jpg" alt="CloudSSH Demo Video" width="720" />
    <br/>
    <img src="https://img.shields.io/badge/%E2%96%B6_Click_to_Play_Video-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white" alt="Play" />
  </a>
  <p><sub>Video duration 19:48 · Full CloudSSH walkthrough</sub></p>
</div>

## Table of Contents

- [Highlights](#highlights)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Deployment](#quick-start)
  - [GitHub Integration](#method-1-deploy-via-github-integration-recommended)
    - [Automatically Sync Upstream](#optional-automatically-sync-upstream-releases)
  - [Configurable Environment Variables](#configurable-environment-variables)
  - [Configure Turnstile](#optional-configure-turnstile-human-verification)
  - [Configure GitHub OAuth](#optional-configure-github-oauth-login--server-management)
- [Development](#development)
  - [Local Development](#local-development)
  - [Tech Stack](#tech-stack)
- [Contributors](#contributors)
- [License](#license)

<a id="highlights"></a>

## Highlights

### Ultimate Serverless

- **Zero Server Cost**: Pure frontend + Cloudflare Workers, no backend servers to maintain.
- **Edge Acceleration**: Cloudflare's global edge network routes connections to the nearest location for low-latency SSH.

### Out of the Box

- **One-Click Deployment**: Fork the repo and connect GitHub in the Cloudflare Dashboard to build and deploy automatically, no local environment needed.
- **Modern Tech Stack**: TypeScript + Vite + Tailwind CSS + xterm.js, balancing performance and maintainability.

### Secure and Reliable

- **Two-Segment Encryption**: HTTPS/WSS between browser and Worker; the Worker-to-server segment uses the full SSH-2.0 protocol (Curve25519-SHA256/ECDH-NISTP256 key exchange, AES-256-GCM/CTR encryption, HMAC-SHA2 integrity).
- **Host-Key Verification**: Ed25519/ECDSA P-256/P-384/P-521/RSA signature checks with a SHA-256 fingerprint on first connection (TOFU).
- **Defense in Depth**: IPv6/reserved-address SSRF blocking plus DNS-rebinding protection, bounded in-memory rate limiting, Turnstile verification, and AES-256-GCM encryption for saved credentials in per-user SQLite storage.
- **Session Isolation**: Each terminal session runs in an independent Durable Object; an active outbound SSH TCP connection keeps it awake.
- **Internal Credential Flow**: On one-click connect, the server decrypts credentials and hands them to the session via a one-time token; the browser never sees the plaintext.

<a id="features"></a>

## Features

- **Pure TypeScript SSH-2.0 Implementation**: Fully self-developed SSH protocol stack, with no dependency on any third-party SSH libraries, implementing all cryptographic operations based on Web Crypto API.
- **Multi-Algorithm Key Exchange**: Supports Curve25519-SHA256 (preferred) and ECDH-NISTP256 KEX algorithms, compatible with various SSH servers (including Dropbear).
- **Reliable Key Transitions and Packet Framing**: Re-evaluates encryption and authentication state for every packet, including servers that return `SSH_MSG_NEWKEYS` and the first encrypted packet in the same TCP chunk.
- **IPv4/IPv6 Dual Stack**: Full support for both IPv4 and IPv6 address connections, including automatic handling of IPv6 bracket notation.
- **Multiple Auth Methods**: Supports standard SSH password authentication, multi-round RFC 4256 `keyboard-interactive` authentication, and OpenSSH-format Ed25519, ECDSA P-256/P-384/P-521, and RSA private keys. Interactive authentication supports passwords, OTPs, multiple prompts, and a second factor after public-key authentication. Server prompts appear in a connection-bound safety dialog, and a saved password is substituted only after an explicit user action. RSA uses RSA-SHA2-256/512 by default; legacy `ssh-rsa` SHA-1 is allowed only through explicit compatibility configuration.
- **SSH Jump Hosts / Bastions**: Signed-in users may select another saved server as a jump host. CloudSSH builds each layer with the standard RFC 4254 `direct-tcpip` channel and does not require `ssh`, `nc`, or `socat` on the remote host. Up to 3 jump hosts are supported; the final target's terminal, SFTP, and AI Agent use the complete encrypted chain. Authentication and path-scoped host-key verification run independently at every hop.
- **One-Time SSH Access Sharing**: Optionally lets signed-in users share saved servers. The link contains only a 256-bit random capability, never the host, username, password, private key, or jump route. Only its hash is stored; it can be claimed once and has separate claim and session lifetimes. Shared sessions allow the terminal and SFTP while the backend disables AI Agent, OS detection, host-key mutation, and reconnect. Owners can revoke live access and review share-only lifecycle, SFTP, and terminal-output records.
- **MitM Protection (TOFU)**: Automatically extracts and prints the server's Host Key (SHA-256 fingerprint) on the first connection, supporting Ed25519/ECDSA/RSA signature verification, and caches known host keys locally and via API to prevent MitM on future connections.
- **Geek Terminal Experience**: Powered by `@xterm/xterm` and the `@xterm/addon-webgl` hardware acceleration rendering engine, ensuring silky smooth scrolling even with massive log outputs.
- **Reliable Terminal Clipboard Interaction**: Completing a terminal selection with a mouse automatically copies it, and right-click pastes directly. On touch devices, tapping Copy in the shortcut bar enters selection mode; drag across terminal text and tap Copy again to finish, avoiding unreliable long-press selection, while Paste remains a separate action. Paste data follows xterm.js's native input pipeline, emits bracketed-paste control sequences only when the remote application enables that mode, and normalizes line endings for compatibility with Vim and regular shells.
- **Mobile Terminal Support**: Phones and tablets get dynamic visual-viewport sizing, soft-keyboard and safe-area handling, iOS Chinese IME compatibility, a compact action bar, one-shot Ctrl/Alt, Esc/Tab/arrows/Home/End/PgUp/PgDn shortcuts, and full-screen Agent/SFTP panels. After a page returns from the background, CloudSSH actively validates the WebSocket and replaces connections that only appear open. Anonymous sessions rebuild SSH from the current in-memory credentials, while signed-in saved servers request a fresh one-time connection token; the UI and terminal input return to the connected state only after `shell_ready`. Users may explicitly request fullscreen landscape; unsupported orientation locks fall back to a manual rotation hint without changing desktop layouts. If the mobile OS completely discards the page, the current shell cannot be resumed seamlessly.
- **Customizable UI**: Theme V3 offers built-in Standard Dark, Standard Light, Cyberpunk, Apple, Gruvbox, CRT Amber, and Glass themes. V3 adds gradient/mesh background layers (with a readability scrim and a slow drift animation), a scanline/flicker/glow/noise effect registry, an independent surface-blur tier, and typography scaling, so themes differ far beyond color swaps. The companion [GitHub Pages theme editor](https://newbietan.github.io/CloudSSH/) provides live controls for colors, shape, density, font, shadows, motion, background layers, effects, and button/input/card/tab styles, with previews for login, server list, terminal + SFTP, and the AI Agent panel. Themes are imported, exported, backed up, and shared as JSON files. Signed-in users sync imported themes to their account for cross-browser restoration, while anonymous users keep them in the current browser only.
- **SFTP Graphical File Manager**: Integrated with a complete SFTP v3 file transfer protocol, providing a graphical file browser interface. Supports directory browsing, file upload/download, creating new folders, file renaming, and deletion, plus plain selection, `Cmd/Ctrl` toggle selection, `Shift` range selection, select all, batch file downloads, and batch deletion. Built on the SSH subsystem, it runs alongside terminal sessions without interference and supports download queues and upload cancellation.
- **Native File Transfer**: Integrated with [trzsz.js](https://github.com/trzsz/trzsz.js), supporting `trz` (upload) / `tsz` (download) commands for file transfer, fully compatible with tmux sessions. Also supports drag-and-drop file upload to the terminal, directory transfer, and resumable transfers. (Requires [trzsz](https://trzsz.github.io/) installed on the remote server)
- **Bilingual UI**: Ships built-in Simplified Chinese and English translations, automatically following the browser language with a manual override; the choice is persisted via a URL parameter or local storage (`cloudssh_locale`).
- **GitHub OAuth Integration**: Supports GitHub login, allowing users to save and manage frequently used SSH servers for one-click connections. Each server can have up to 10 normalized tags; the list supports instant search by name, host, or username, tag filtering, and responsive pagination (9 cards per page on desktop, 6 on tablets, 3 on mobile).
- **Custom Command Snippets**: Signed-in users can save frequently used commands under a name and reuse them via server-side search. Snippets are stored in `UserDBDO` with per-`user_id` row-level isolation (name ≤50, command ≤2000, ≤100 per user); anonymous users fall back to local `localStorage`. Supports fill-in, fill-and-run, edit, and delete, reachable from the toolbar on desktop and mobile, and hidden inside one-time share sessions.
- **Automatic Server OS Detection**: When a signed-in user first connects to a saved server without an OS record, CloudSSH uses a separate SSH exec channel after the terminal is ready to read `/etc/os-release` or `uname`, then shows the corresponding system icon on the server card. Detection runs in the background without blocking the terminal. Only recognized results are saved; unknown results are retried naturally on the next connection, and changing the host or port clears stale results. Anonymous connections do not run this check. The read-only command may appear in the target server's SSH audit logs.
- **Private IP Display and Quick Copy**: Valid IPv4 and IPv6 addresses are visually masked in the saved-server list and connection status bar to reduce accidental disclosure in demos or screenshots. The complete connection address remains available through mouse or keyboard copy. Hostnames remain unchanged; visual masking is not encryption or access control.
- **Single-Page Multi-Tab Session**: Switch between multiple independent SSH terminal and SFTP instances within a single browser tab, with isolated sandbox environments. While on the server list or anonymous connection page, a toolbar/form button returns you to an established SSH session in one click, and pressing `Esc` does the same when the terminal is hidden; the button appears and hides along with the tab count.
- **Secure Connection History**: Saves last 5 connection records locally. Credentials (passwords/private keys) can be client-side encrypted using locally derived AES-256-GCM keys.
- **Dual-Segment Latency & Colo Display**: Instantly and periodically monitor WebSocket RTT (client to CF), physical latency (CF to SSH host), and the current Cloudflare datacenter code (e.g. `CF-LAX`) on the status bar, with green, yellow, and red indicators for network quality.
- **Smart Region Scheduling (locationHint)**: Queries IPinfo when a direct server is saved, persists the inferred Durable Object region, and reuses it on connection without another runtime geo lookup. With SSH jumps, only the outermost entry reached directly by Cloudflare is inferred; downstream private servers do not trigger a lookup and inherit placement from that entry. Failures fall back to Cloudflare's default placement, and users may manually override direct-entry regions. _Note: automatic inference sends the direct entry's host information to the third-party IPinfo service. locationHint is a Cloudflare best-effort feature and may fall back to a nearby region when capacity is unavailable._
- **In-Terminal Text Search**: Real-time log search support via `Ctrl+Shift+F`.
- **Terminal Log Export**: Download the entire screen buffer of the active terminal session as a `.txt` file with a single click on the header download button, avoiding browser freezes when selecting long logs.
- **AI Agent Assistant**: Built-in AI Agent sidebar with BYOK (Bring Your Own Key) support for OpenAI-compatible APIs (e.g., DeepSeek). Provides 8 specialized operations tools: execute commands, read terminal context, detect server environment, list processes, manage systemctl services, manage Docker containers, user confirmation, and structured report output. Selecting terminal text exposes an “Ask AI assistant” action that attaches the complete selection to the current tab's composer instead of sending it immediately. The attachment shows its source and size, can be expanded, replaced, or removed, and is sent only after the user adds a question. Terminal selections are explicitly treated as untrusted analysis data—not action authorization—and cannot override user instructions. Agent code blocks support one-click copy, while safe single-line Shell commands can be filled into the active terminal without being executed automatically. Supports LLM streaming output (character-by-character display). Dangerous commands are automatically blocked or require confirmation in a safe, reject-by-default dialog. **Thinking Process Container**: During multi-step tasks, displays the latest 1-2 commands in real-time, auto-collapses with total step count after completion, expands to show full execution history.
- **Quality Gates**: Before deploying either `test` or `main`, GitHub Actions performs frozen-lockfile installation, Worker/frontend type checking, unit and integration tests, reproducible frontend builds, Playwright browser E2E, and axe accessibility regression. Any failure blocks deployment.

<a id="architecture"></a>

## Architecture

### System Architecture

```mermaid
flowchart TB
    subgraph "Browser Client"
        UI["Frontend UI<br/>TypeScript + xterm.js"]
        SFTP["SFTP File Manager"]
        Agent["AI Agent Assistant"]
        Trzsz["trzsz File Transfer"]
    end

    subgraph "Cloudflare Edge Network"
        Worker["Worker<br/>Routing + API"]
        SSH_DO["SSHSessionDO<br/>SSH Session Management"]
        User_DO["UserDBDO<br/>User Data Management"]
        Share_DO["SSHShareDO<br/>Share Capability + Audit"]
        AgentCore["AgentCore<br/>AI Control Loop"]
    end

    subgraph "Target Server"
        SSH["SSH Server<br/>(OpenSSH/Dropbear)"]
    end

    UI <-->|"WebSocket<br/>Terminal I/O"| Worker
    SFTP <-->|"WebSocket<br/>SFTP Data"| Worker
    Agent <-->|"WebSocket<br/>Agent Messages"| Worker
    Trzsz <-->|"trzsz Protocol"| UI
    Worker <-->|"WebSocket"| SSH_DO
    Worker <-->|"Internal API"| User_DO
    Worker <-->|"Claim / Revoke / Read Audit"| Share_DO
    SSH_DO -->|"Lifecycle / SFTP / Terminal Output"| Share_DO
    SSH_DO <-->|"TCP Socket<br/>@cloudflare/sockets"| SSH
    SSH_DO <-->|"Exec Channel"| AgentCore
    AgentCore <-->|"LLM API"| External["External LLM Service"]
```

<a id="quick-start"></a>

## Quick Deployment

### Prerequisites

- A Cloudflare account.
- Cloudflare Workers Free Plan enabled (required for TCP Sockets and Durable Objects features).

### Steps

#### Method 1: Deploy via GitHub Integration (Recommended)

<div align="center">
  <a href="https://dash.cloudflare.com/?url=https://github.com/newbietan/CloudSSH">
    <img src="https://img.shields.io/badge/Deploy_to_Cloudflare-FF6633?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Deploy to Cloudflare">
  </a>
  <p>Click the button to jump to the Cloudflare console — authorize your GitHub account and deploy automatically, no local environment required</p>
</div>

1. **Fork this repository** to your GitHub account.
2. **Create Worker App**: Log in to Cloudflare, go to Workers & Pages, click Create Application, connect your GitHub account, and select the forked repository.
3. **Build Command**: During deployment settings, enter `pnpm run build:frontend` as the Build command, then save and deploy.
4. **Access the App**: After successful deployment, access via the default domain `https://cloudssh.<your-subdomain>.workers.dev`.
5. **Bind Custom Domain** (Optional): Go to Worker Settings → Domains & Routes → Add, enter your domain and confirm.

> **Note**: To deploy a test environment, repeat the above steps on the `test` branch to create a separate Worker (e.g., `cloudssh-test`). The Durable Objects data between both environments is completely isolated.

##### Optional: Automatically Sync Upstream Releases

A fork can use the built-in `Sync upstream` GitHub Actions workflow to periodically synchronize the latest `main` branch from this project into its own `main` branch. This feature is **disabled by default**. Once enabled, it checks daily at 04:20 Asia/Shanghai; branch updates created by a successful sync are automatically built and deployed by Cloudflare Git integration, so no additional deployment toggle is required.

1. Make sure the Cloudflare Worker is connected to your fork, its Production branch is set to `main`, and automatic builds are enabled.
2. Open the fork's **Actions** page and enable workflows. If an existing fork does not yet contain `Sync upstream`, first use GitHub's **Sync fork** feature once to obtain the workflow.
3. Go to **Settings → Secrets and variables → Actions → Variables** and create a Repository variable:
   - Name: `AUTO_SYNC_UPSTREAM`
   - Value: `true`
4. To sync immediately, open **Actions → Sync upstream → Run workflow**. Manual runs do not require the variable above.

> **Sync behavior**: The workflow uses GitHub's fork synchronization API, requires no PAT, and never force-overwrites the branch. If your `main` branch cannot be merged with upstream automatically, the job fails while preserving the existing code and the conflict must be resolved manually. Avoid editing the deployment `main` branch directly, and keep domains, secrets, and environment variables in the Cloudflare Dashboard.

#### Configurable Environment Variables

All optional features are controlled by Worker environment variables set in the Cloudflare Dashboard under Settings → Variables and Secrets (sensitive ones should use the **Secret** type) and applied on the next redeploy:

| Environment Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Required for GitHub login | GitHub OAuth application credentials |
| `BASE_URL` | Required for GitHub login | OAuth callback URL; must match your deployed domain |
| `GITHUB_ALLOWED_USER_IDS` | Optional | Comma-separated GitHub **numeric user IDs** allowed to sign in; omitted = unrestricted, an empty or malformed value fails closed |
| `REQUIRE_GITHUB_AUTH` | Optional | Set to `true` to disable anonymous SSH and require a valid GitHub session for every connection |
| `ENABLE_SSH_SHARING` | Optional | Set to `true` to enable one-time SSH sharing (disabled by default) |
| `TURNSTILE_SECRET` / `TURNSTILE_SITEKEY` | Optional | Cloudflare Turnstile human-verification keys |
| `STRICT_HOST_KEY_VERIFY` | Optional | Host-key signature verification: set to `false` to skip verification failures (default `true`, fails closed) |
| `DEBUG_MODE` | Optional | Set to `true` to output debug information (`wrangler.toml` defaults to `false`) |

> **Note**: For local CLI deployment or debugging the Worker, see the Local Development section under Development below.

#### Optional: Configure Turnstile Human Verification

To prevent malicious bot abuse, it is recommended to enable Cloudflare Turnstile verification:

1. **Create Turnstile Widget**: Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/), go to the Turnstile page and create a new Widget.
2. **Get Keys**: After creation, you will receive a **Site Key** (public) and a **Secret Key** (private).
3. **Configure Environment Variables**: In the Cloudflare Dashboard Workers settings, go to "Settings" → "Variables and Secrets", add the following environment variables:
   - `TURNSTILE_SECRET` = your Secret Key
   - `TURNSTILE_SITEKEY` = your Site Key
4. **Redeploy**: Run the deployment command to apply the configuration.

> **Environment Variable Type Recommendation**: It is recommended to set all environment variables as **Secret** type. Secrets are stored in Cloudflare's encrypted storage, separate from code deployments, and will not be overwritten or lost during redeployments. When adding variables in the Dashboard, simply select the "Secret" type.

> **Note**: Turnstile verification is session-level. After verification, all features are available for the current session. Closing the browser will require re-verification.

#### Optional: Configure GitHub OAuth Login & Server Management

With GitHub OAuth enabled, users can log in with their GitHub account and save/manage their frequently used SSH servers in a personal dashboard for one-click connections. When not configured, this feature is automatically hidden and does not affect the anonymous SSH connection functionality.

1. **Create a GitHub OAuth App**:
   - Go to GitHub → Settings → Developer settings → OAuth Apps → [New OAuth App](https://github.com/settings/applications/new)
   - **Application name**: `CloudSSH` (customizable)
   - **Homepage URL**: `https://your-domain.com` (your deployed domain)
   - **Authorization callback URL**: `https://your-domain.com/api/auth/callback`
   - After creation, note the **Client ID**, then click **Generate a new client secret** to get the **Client Secret** (shown only once, save it immediately)

2. **Configure Environment Variables**: In the Cloudflare Dashboard Workers settings, go to "Settings" → "Variables and Secrets", add the following environment variables:
   - `GITHUB_CLIENT_ID` = your Client ID
   - `BASE_URL` = `https://your-domain.com` (your deployed domain)
   - `GITHUB_CLIENT_SECRET` = your Client Secret

   The following two independent settings are optional:

   - `GITHUB_ALLOWED_USER_IDS`: Comma-separated GitHub **numeric user IDs** allowed to sign in, for example `83105156,6236783`. When omitted, every GitHub account may sign in. An empty or malformed configured value fails closed and denies every GitHub sign-in.
   - `REQUIRE_GITHUB_AUTH`: Set to `true` to disable anonymous SSH and require a valid GitHub session for every SSH WebSocket. When omitted or set to `false`, anonymous connections remain available.
   - `ENABLE_SSH_SHARING`: Set to `true` to let signed-in users create one-time links for saved servers. It is disabled by default. Enabling it explicitly permits a bearer of the share capability to open an audited SSH session without signing in to GitHub.

   **Find a GitHub numeric user ID**:

   - Open `https://api.github.com/users/octocat` in a browser (replace `octocat` with the actual username) and read the `id` field in the returned JSON. For example, `"id": 583231` means the numeric user ID is `583231`.
   - Or run:

     ```bash
     curl -s https://api.github.com/users/octocat | jq '.id'
     ```

   Use `id`, not the username or `node_id`. The numeric ID does not change when the username changes; separate multiple IDs with commas.

| Configuration                   | GitHub sign-in         | Anonymous SSH                    |
| ---------------                 | ----------------       | ---------------                  |
| Neither setting                 | All GitHub users       | Allowed                          |
| `GITHUB_ALLOWED_USER_IDS` only  | Allowlisted users only | Allowed                          |
| `REQUIRE_GITHUB_AUTH=true` only | All GitHub users       | Disabled                         |
| Both settings                   | Allowlisted users only | Disabled (private-instance mode) |

1. **Redeploy**: Save the variables and redeploy the existing Worker. The Durable Object migration in the repository initializes the required classes and database; deleting the existing Worker is not required.

> **Environment Variable Type Recommendation**: `GITHUB_CLIENT_SECRET` must use the **Secret** type. `GITHUB_ALLOWED_USER_IDS` and `REQUIRE_GITHUB_AUTH` contain no credentials and may use plain-text variables. Secrets are stored in Cloudflare's encrypted storage, separate from code deployments, and will not be overwritten or lost during redeployments.

> **Access Policy Note**: After `GITHUB_ALLOWED_USER_IDS` changes, existing sessions are checked again and become invalid on their next request; already established SSH WebSockets are not terminated. `REQUIRE_GITHUB_AUTH=true` depends on GitHub OAuth, so configure the Client ID, Client Secret, and `BASE_URL` together.

##### Using One-Time SSH Sharing

1. Configure GitHub OAuth, set `ENABLE_SSH_SHARING=true` on the Worker, and redeploy.
2. Connect normally to the target and every jump host first so all route-scoped host fingerprints are trusted.
3. Select Share on the server card, then choose a claim window (5/15/30/60 minutes) and maximum session duration (15/30/60/120 minutes).
4. Copy the generated link immediately and send it through a trusted channel. CloudSSH does not retain the plaintext capability, so the same link cannot be displayed again.
5. The recipient opens the link and accepts terminal-output and SFTP recording before claiming it. A link can be claimed once; refresh, disconnect, or tab closure cannot reconnect it.
6. The owner can reopen Share management to inspect status and audit records or revoke a pending/live share. Revoking a live share closes both terminal and SFTP.

> [!WARNING]
> Although the capability contains no SSH metadata, possession grants a full Shell and SFTP session using the owner's saved credential, so protect it like a temporary password. Sharing requires trusted fingerprints for the complete route and stops on fingerprint changes or `keyboard-interactive`/MFA challenges. Audit stores server PTY output rather than raw keyboard input: it usually shows shell-echoed commands but cannot prove every command executed with echo disabled, inside scripts, or through encoded input. Do not treat it as host-level enhanced auditing. A session is closed if its 5 MiB recording limit is reached or audit writes fail.

> **Note**: Server credentials (passwords/private keys) are encrypted with AES-256-GCM in each user's UserDBDO SQLite database. The current encryption key is generated on first use and stored in the same Durable Object database as the ciphertext. For a saved-server connection, the browser never receives the plaintext credential; the server side transfers it internally through a one-time connection token.

##### Using SSH Jump Hosts

Jump hosts require no additional environment variables, but GitHub OAuth and saved servers must be enabled:

1. Save the outermost public jump host A, which Cloudflare can reach directly.
2. Save target B and select A in the **Jump host** field. B may use a private address that is reachable only from A.
3. For a multi-hop path such as C → A → B, configure C as A's jump host, then configure A as B's jump host. CloudSSH resolves the relation recursively and permits at most 3 jump hosts.
4. Connect to B from the server list. Terminal, SFTP, and AI Agent channels open only on final target B; a failure at any hop closes or rebuilds the complete chain.

Every server in a jump relation must belong to the same GitHub user. Self-references and cycles are rejected, and a jump host cannot be deleted while another server references it. Public-address SSRF checks and Durable Object region placement use the outermost address reached directly by Cloudflare. Only that entry runs automatic region inference; selecting a jump host disables the downstream server's region option and does not send its private host information to IPinfo. Private targets are accepted only inside a server-resolved saved chain, and anonymous clients cannot submit jump configuration. TOFU host-key verification runs at every hop, with private target records scoped by the complete jump path.

<a id="development"></a>

## Development

### Project Structure

This project uses pnpm monorepo workspace structure:

```
CloudSSH/
├── src/                    # Backend source (Cloudflare Worker)
│   ├── ssh/                # SSH protocol pure implementation layer
│   └── worker/             # Worker entry and Durable Objects
│       ├── agent/          # AI Agent control loop, tools, safety
│       ├── dns-check.ts    # DNS-rebinding SSRF defense
│       └── ip-geo.ts       # IPinfo region inference → locationHint
├── frontend/               # Frontend source (independent workspace)
│   └── src/                # TypeScript + xterm.js + trzsz
│       ├── agent/          # AI assistant sidebar UI
│       └── i18n/           # Chinese/English strings and locale resolution
├── docs/                   # GitHub Pages static assets
│   └── theme-editor/       # Visual theme editor
├── scripts/                # Build scripts
├── tests/                  # Vitest unit/integration + Playwright E2E and axe regression (build/ e2e/ ssh/ worker/)
├── .github/workflows/      # CI/CD workflows (deploy / github-pages / sync-upstream)
├── biome.json              # Code formatting and lint conventions
├── playwright.config.ts    # Browser E2E test configuration
├── pnpm-workspace.yaml     # pnpm workspace configuration
└── wrangler.toml           # Cloudflare deployment configuration
```

### Local Development

#### Environment Setup

1. **Fork and Clone the Repository**

   ```bash
   git clone https://github.com/<your-username>/CloudSSH.git
   cd CloudSSH
   ```

2. **Install Dependencies** (root and frontend separately)

   ```bash
   pnpm install
   cd frontend && pnpm install
   ```

3. **Login to Cloudflare** (required on first run, credentials are cached afterward)

   ```bash
   npx wrangler login
   ```

   > **Note**: When using Wrangler Dev for local development, it connects to your Cloudflare account to access Durable Objects and TCP Sockets. Real SSH TCP traffic is forwarded through Cloudflare's infrastructure.

4. **Configure GitHub Actions** (Optional, for automatic deployment)

   If you want to deploy to your own Cloudflare account via GitHub Actions, modify the repository owner in `.github/workflows/deploy.yml`:

   ```yaml
   if: github.repository_owner == 'your-github-username'
   ```

   Also configure the following Secrets in your repository Settings → Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID

#### Start Development Server

```bash
pnpm run dev
```

This command builds the frontend and starts the Wrangler local development environment, supporting:

- Automatic rebuild on frontend code changes
- Automatic reload on Worker code changes
- Full Durable Objects and TCP Sockets functionality

After the dev server starts, visit the local address shown in the terminal (usually `http://localhost:8787`) to start debugging.

#### Common Development Commands

| Command                   | Description                                               |
| ---------                 | -------------                                             |
| `pnpm run dev`            | Build frontend + start Wrangler dev server                |
| `pnpm run build:frontend` | Build frontend only (output to `frontend/dist/`)          |
| `pnpm run typecheck`      | Type-check Worker and frontend TypeScript                 |
| `pnpm test`               | Run Vitest unit and integration tests                     |
| `pnpm run test:e2e`       | Run Playwright browser E2E and axe accessibility tests    |
| `pnpm run verify`         | Run type checks, tests, production build, and browser E2E |
| `pnpm run deploy:test`    | Build and deploy the isolated test environment            |

#### Submitting Changes

**Do NOT create feature branches.** All changes must be committed directly to the `test` branch to keep the repository clean.

```
test branch (dev/test)  ──merge──>  main branch (production)
```

1. Switch to the `test` branch: `git checkout test`
2. Pull the latest code: `git pull origin test`
3. Develop and test locally
4. Commit and push directly: `git push origin test`
5. After testing passes, the maintainer will merge `test` into `main`

> **Note**: The `main` branch has protection rules that prevent direct pushes. All changes must be committed to the `test` branch first. Do NOT create `feat/xxx`, `fix/xxx` or any other feature branches — commit directly to `test`.

### Tech Stack

| Layer                  | Technology                                         | Description                                                                                                                        |
| -------                | ------------                                       | -------------                                                                                                                      |
| **Frontend**           | TypeScript + Vite + xterm.js                       | Web terminal emulator, WebGL hardware acceleration                                                                                 |
| **i18n**               | Lightweight custom i18n (`frontend/src/i18n`)      | Simplified Chinese / English dual-language UI with automatic browser detection and manual switching                                |
| **UI Framework**       | Tailwind CSS (local Vite/PostCSS build) + Theme V3 | The app supports built-in theme switching, custom JSON import, and signed-in account sync; editing and export live on GitHub Pages |
| **File Transfer**      | trzsz.js                                           | Supports trz/tsz commands, drag-and-drop upload, resumable transfers                                                               |
| **AI Assistant**       | BYOK + OpenAI-compatible API                       | Bring your own API key, supports DeepSeek and other compatible models                                                              |
| **Backend**            | Cloudflare Workers                                 | Serverless edge computing                                                                                                          |
| **Session Management** | Durable Objects                                    | SSH session isolation; browser WebSockets use the Hibernation API entry pattern, while active outbound TCP prevents hibernation    |
| **Data Storage**       | Durable Objects SQLite                             | User data, server configurations                                                                                                   |
| **Package Manager**    | pnpm (workspace)                                   | Monorepo dependency management                                                                                                     |

<a id="contributors"></a>

## Contributors

Thank you to the following contributors for improving CloudSSH's code, compatibility, and user experience:

| Contributor                                          | Key Contributions                                                                                                                                                           |
| -------------                                        | -------------------                                                                                                                                                         |
| [TanXin (@newbietan)](https://github.com/newbietan)  | Project creator and maintainer; Cloudflare Serverless architecture, SSH/SFTP, AI Agent, security, theming, and engineering infrastructure                                   |
| [David xu (@xqdoo00o)](https://github.com/xqdoo00o)  | Dropbear compatibility, migration to trzsz file transfer, PTY sizing, and session exit/reconnection improvements                                                            |
| [vonl1 (@vonl1)](https://github.com/vonl1)           | Terminal selection auto-copy, Vim-compatible right-click paste, masked IPv4/IPv6 display with quick full-address copy, and automatic server OS detection with branded icons |
| [Leon Xu (@xuthuslei)](https://github.com/xuthuslei) | Fixed encryption-state transitions and packet parsing when `SSH_MSG_NEWKEYS` and the first encrypted packet arrive in the same TCP chunk; fixed the v1.11.0 jump-host authentication-timing regression (#108) |

The list and contribution summaries are based on Git history and accepted Pull Requests; one contributor may appear under multiple historical Git author names or email addresses. See [GitHub Contributors](https://github.com/newbietan/CloudSSH/graphs/contributors) for the complete record. Issues and Pull Requests are welcome.

<a id="license"></a>

## License

This project is open-sourced under the [Apache License 2.0](LICENSE).

**Original Author and Attribution Requirement**: CloudSSH was initiated and architected by [TanXin (@newbietan)](https://github.com/newbietan), who continues to maintain the project. Any modified, derivative, or redistributed version based on this project must retain the license, copyright, and attribution notices in [LICENSE](LICENSE) and [NOTICE](NOTICE), and clearly state in its documentation or other accompanying notices: “This project is based on CloudSSH, originally created by TanXin (@newbietan),” together with a link to the original project.

Commercial use, modification, and redistribution remain governed by the [Apache License 2.0](LICENSE). The attribution requirement above preserves the source and authorship of the original project without restricting other rights granted by the license.

Issues and Pull Requests are welcome to help build the community. If you find this project helpful, please consider giving it a ⭐ Star. Thank you very much for your support!

## Star History

<a href="https://www.star-history.com/?repos=newbietan%2FCloudSSH&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=newbietan/CloudSSH&type=date&theme=dark&legend=top-left&sealed_token=W6EXioqdcb2BEJNCLBVZIvRGDUYCaxki-xY1FfDVex2S8hS-ABAc84mDRxLIx0wQLFCd3Wh_p-t4bD4yT_iPkhi0_7Aciixag0Vj0_Qsqv3Wh_pbiD6Ykw" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=newbietan/CloudSSH&type=date&legend=top-left&sealed_token=W6EXioqdcb2BEJNCLBVZIvRGDUYCaxki-xY1FfDVex2S8hS-ABAc84mDRxLIx0wQLFCd3Wh_p-t4bD4yT_iPkhi0_7Aciixag0Vj0_Qsqv3Wh_pbiD6Ykw" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=newbietan/CloudSSH&type=date&legend=top-left&sealed_token=W6EXioqdcb2BEJNCLBVZIvRGDUYCaxki-xY1FfDVex2S8hS-ABAc84mDRxLIx0wQLFCd3Wh_p-t4bD4yT_iPkhi0_7Aciixag0Vj0_Qsqv3Wh_pbiD6Ykw" />
 </picture>
</a>
