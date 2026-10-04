# Agent Terminal IDE.

> **Desktop Terminal IDE for launching, managing, and multiplexing multiple CLI coding agents (Claude Code, Codex CLI, Aider) in a high-performance grid layout for Windows, macOS, and Linux.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Electron](https://img.shields.io/badge/Electron-31.2.0-blue)
![xterm.js](https://img.shields.io/badge/xterm.js-5.5.0-green)
![tmux](https://img.shields.io/badge/session--backend-tmux-orange)

---

## Core Features.

### Extension marketplace

The Extensions sidebar searches Open VSX and installs VSIX packages without a
category restriction, including themes, snippets, language/tool extensions,
web extensions, and extension packs. Packages persist in the `extensions`
directory under Electron's application data directory. Installation selects a
matching platform package when available, installs dependencies and pack members,
and exposes installed versions, updates, and uninstall in the existing sidebar.

Use **Open Extension Editor** in the Extensions sidebar or an installed package's
details to run extensions in a separate VSCodium editor window. This provides the
VS Code workbench and extension host for executable extensions, language tools,
debuggers, and extension panels. Orion loads its installed packages and current
workspace there. Extensions activate according to their own file, command, and
view triggers. Individual packages can still require credentials, external tools,
particular API versions, or proprietary services; this does not guarantee that
every marketplace package will work.

On Windows x64/arm64, the first launch downloads the official VSCodium ZIP and
verifies its SHA-256 checksum before extraction. An existing standard VSCodium
installation is reused when available. On macOS/Linux, install VSCodium in its
standard location first. Runtime files, editor settings, and the synchronized
extension directory live under `extension-editor` in Orion's application data;
your personal editor profile is not modified.

After opening Extension Editor, file opens from Orion use that editor. Use
**Use Built-in Editor** to switch back; existing windows remain open. After
installing, updating, or uninstalling packages in Orion, reopen Extension Editor
to synchronize them and reload its window if necessary. Extensions installed
directly in the VSCodium window remain in that editor's separate extension directory.

The built-in Monaco editor continues to support JSON color themes (editor colors
and approximate token color mapping) and snippets. Select **Use [theme name]**
in an installed theme's details to apply it to the built-in editor.

Claude Code (`anthropic.claude-code`) also supports **Run Claude Code in Terminal**
in its installed-extension details. This starts the package's bundled native CLI
in a new Orion terminal in the opened project. Follow Claude's setup and sign-in
instructions there. Use **Open Extension Editor** for the extension's editor panel.

Run `npm run test:extensions` for the installation and renderer tests. Run
`node test/extension-marketplace-live.js` to verify real registry downloads in
a temporary directory. `node test/verify_extensions.js` verifies installation,
theme application, uninstall, and the existing terminal/editor layout in Electron
with isolated application data.
`node test/extension-editor-live.js` downloads/caches a verified VSCodium runtime
and tests real Open VSX Prettier activation/formatting, diagnostics, and webviews
in a disposable editor profile.

- **Dynamic Terminal Grid Layout**: Manage 4–6 terminal panes simultaneously arranged in **2x3** or **3x2** layout grids with real-time xterm.js reflowing on window and pane resize
- **tmux Persistent Backend**: Every terminal session is backed by a detached tmux session (`tmux new-session -A -s ide-<uuid>`). If the app crashes or quits, your CLI agent tasks continue executing in the background and reattach seamlessly upon app restart with scrollback intact.
- **Orphan Session Detection & Recovery**: Automatically detects orphaned `ide-*` tmux sessions on app startup and offers a 1-click interface to reattach them into active grid panes.
- **CLI Agent Presets**: Pre-populated with presets for **Claude Code** (`claude`), **Codex CLI** (`codex`), **Aider AI** (`aider`), and interactive system shells (`bash`/`zsh`).
- **Broadcast Mode**: Toggle broadcast mode to mirror typing across all active terminal panes simultaneously — ideal for benchmarking agent responses on identical prompts.
- **Workspace Presets**: Save and load custom named workspace layouts (pane count, grid proportions, per-pane working directory, and agent assignments) to local storage.
- **Per-Pane Controls**: Custom header with editable label, interactive folder picker (`dialog.selectDirectory`), status indicator (Running, Idle, Exited, Detached), and restart/kill controls.
- **Global Keyboard Shortcuts**: Quick pane navigation (`Ctrl+1..6`), add pane (`Ctrl+Shift+N`), close pane (`Ctrl+Shift+W`), and toggle broadcast (`Ctrl+Shift+B`).

---

## Prerequisites & Installation

The Windows installer upgrades the system installation in Program Files. After
installing version 13, launch **ORION IDE 13** and confirm the window title shows
**v13.0.1**. The app keeps its existing application data location. Builds validate
the packaged marketplace code and reject the obsolete blocked-install UI before
creating an installer.

### 1. Prerequisites
- **Node.js**: Version 18 or 20+
- **tmux**: Required for persistent session management.
  - **Linux (Mint/Ubuntu/Debian)**: `sudo apt update && sudo apt install -y tmux`
  - **macOS**: `brew install tmux`
- **Native Build Tools** (for `node-pty` compilation):
  - **Linux**: `sudo apt install -y build-essential python3`
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)

### macOS quick start

Install Homebrew first if it is not already present, then install the two system requirements:

```bash
xcode-select --install
brew install tmux
npm install
npm run rebuild
npm start
```

On Apple Silicon, run the install and build using the same architecture that will run the application (normally native `arm64` Terminal). Do not copy a `node_modules` directory built on an Intel Mac to Apple Silicon, or vice versa: rerun `npm install` and `npm run rebuild` instead.

### 2. Installation
```bash
# Clone the repository and navigate into directory
git clone https://github.com/your-org/agent-terminal-ide.git
cd agent-terminal-ide

# Install dependencies (automatically runs electron-rebuild via postinstall)
npm install
```

`npm install` may be configured to skip package install scripts in restricted CI environments. In that case, explicitly download Electron and rebuild the native PTY binding:

```bash
npm rebuild electron
npm run rebuild
```

---

## Running the App

### N11X update checks

Orion checks the N11X Update Service in the background, three seconds after its
main window loads. Startup attempts are limited to once per 24 hours, including
failed attempts. The channel and last-attempt time use the existing
`electron-store` dependency in the `updates` preferences store. The default
channel is `stable`. Settings → Orion Updates, Help → Check for Updates, and
the command palette allow manual checks at any time.

The backend origin is centralized in `main/update-config.js`: currently
`http://127.0.0.1:8091`. `N11X_UPDATE_URL` overrides the origin. HTTP is accepted
only on loopback; other origins require HTTPS. The production URL
`https://updates.n11x.dev` is a placeholder and is not enabled.

The implementation was checked against the actual source and documentation at
`/home/madbo1/n11x-update-service`, specifically `src/server/http.mjs`,
`src/services/catalog.mjs`, `src/release/schema.mjs`, `src/security/signing.mjs`,
`docs/api.md`, and `docs/signing.md`. It requests
`GET /v1/orion/latest?channel=stable&platform=windows&architecture=x64&currentVersion=<app.getVersion()>`
on Windows x64. The runtime supplies the platform and architecture; supported
Orion targets are Windows/Linux x64 and macOS x64/arm64. No workspace or user
content, credentials, or telemetry are sent.

Every release decision with a latest version requires a schema-valid manifest
and all Ed25519 signatures verified against pinned public keys. Equal/older
latest responses omit a manifest, so Orion retrieves the original through
`GET /v1/orion/releases/{version}?channel={channel}` before reporting up to date.
It uses the exact N11X UTF-8 array signing encodings and SHA-256 SPKI key IDs.
The selected artifact must match the signed platform/architecture and the
expected same-origin download route. Downloading is manual, streamed, and
checked against the signed size and SHA-256. **Show Download** reveals the
verified file; Orion does not execute an installer.

Production trust belongs in `config/update-keys.json` (`pinnedKeys`, public PEM
strings). It remains empty pending an independently authorized production key.
No key is trusted from an API response. Development overrides
`N11X_UPDATE_PUBLIC_KEY` (public PEM) and `N11X_UPDATE_PUBLIC_KEYS_PATH` (JSON array
of public PEM strings) work only for unpackaged Orion using a loopback backend;
packaged applications ignore these overrides. Never supply a private key.

`npm run test:updater` runs signature/validation/network tests, renderer tests,
and the actual Electron application with disposable fixtures. These fixtures
do not establish real-backend success. `npm run test:updater:live` launches the
actual Orion application against port 8091, records its startup and manual
request identity/response status, and verifies the displayed result. It reports
full success only after processing a real signed manifest. A real
`404 {"error":"release_not_found"}` shows **No Update Published** and the live
test deliberately exits unsuccessfully (Node exit code 2) because signed-release
end-to-end verification is still blocked.

During local verification, a temporary SSH forward bound only to Windows
`127.0.0.1:8091` connected to the existing service on the home server's loopback
port. No server files, public networking, or production signing settings were
changed. Both real startup and manual requests received `release_not_found`;
the real stable catalog returned an empty release list. A release maintainer
must publish a signed Orion artifact for the target and independently supply
its verification public key before the successful real-manifest path can be
verified. Production exposure and installer execution remain separate work.

```bash
# Start Electron application locally
npm start
```

If `node-pty` requires re-compilation against your local Electron version, execute:
```bash
npm run rebuild
```

---

## How tmux Session Persistence Works

Unlike standard terminal emulators that terminate shell processes when closed, **Agent Terminal IDE** leverages `tmux` as an IPC session daemon under the hood:

1. **Session Spawning**: When a pane is launched, `node-pty` spawns:
   ```bash
   tmux new-session -A -s ide-pane-1 -c /path/to/project "claude"
   ```
   The `-A` flag instructs tmux to **attach** to an existing session if one already exists, or create a new session if it doesn't.
2. **Crash & Quit Resilience**: When the Electron app quits, the terminal PTY handles disconnect, but the underlying `tmux` session and running agent processes continue executing in the background.
3. **Orphan Discovery & Reattachment**: On app launch, the main process executes `tmux list-sessions` to find any orphaned `ide-*` sessions. An interactive prompt allows you to reattach all active agent sessions with scrollback history preserved.
4. **Clean Teardown**: Clicking **Kill All Sessions** executes `tmux kill-session` across all `ide-*` instances to ensure zero lingering background processes when desired.

---

## Adding Custom CLI Agent Presets

Preset options are configured via JSON and loaded dynamically. You can add new CLI agent tools (e.g. custom Python scripts, GPT-Engineer, or Aider variants) without editing application code.

### Option A: Edit Project Config (`config/agents.json`)
```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "claude",
      "description": "Anthropic Claude Code CLI",
      "env": {}
    },
    {
      "id": "custom-agent",
      "name": "Custom Agent",
      "command": "python3 /path/to/agent.py --flag",
      "description": "Custom autonomous coding script",
      "env": {
        "API_KEY": "your-key-here"
      }
    }
  ]
}
```

### Option B: User Configuration Directory
Agent presets can also be saved in your user data directory (`<userData>/user_agents.json`), where they persist across app updates.

---

## Keyboard Shortcuts Reference

| Shortcut | Action |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>1</kbd> .. <kbd>6</kbd> | Switch focus directly to Pane 1 to 6 |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> | Add new terminal pane to grid |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>W</kbd> | Close currently focused pane |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> | Toggle Broadcast Mode (keystroke multiplexing) |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> | Kill all active and orphaned tmux sessions |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> *(inside pane)* | Search text inside active terminal scrollback |

---

## Building & Packaging for Linux

The Linux release is an **x64 AppImage**, a self-contained executable that works across mainstream Linux distributions (Ubuntu, Debian, Fedora, Arch, Mint, openSUSE, and others). It must be built on Linux so the native `node-pty` dependency is compiled for Linux; use the included GitHub Actions workflow for builds from Windows or macOS.

```bash
# Build the portable Linux AppImage from a Linux machine
npm run dist
```

The output will be generated in the `./dist/` directory:
- `dist/agent-terminal-ide-4.0.0-x64.AppImage`

On GitHub, run the **Build Linux AppImage** workflow manually or push a version tag. A tag such as `v4.0.0` also creates a GitHub Release with the AppImage attached, so users can download the latest release with the GitHub CLI:

```bash
gh release download --repo mehboii/THE-IDE- --pattern '*.AppImage'
```

To download a particular version, replace `v4.0.0` below with its release tag:

```bash
gh release download v4.0.0 --repo mehboii/THE-IDE- --pattern '*.AppImage'
```

Manual workflow runs provide the `linux-appimage-x64` Actions artifact instead. On the target machine:

```bash
chmod +x agent-terminal-ide-*-x64.AppImage
./agent-terminal-ide-*-x64.AppImage
```

The target machine still needs `tmux` installed for persistent terminal sessions. On distributions with FUSE 2 unavailable, AppImages can be launched with `APPIMAGE_EXTRACT_AND_RUN=1 ./agent-terminal-ide-*-x64.AppImage`.

### macOS package

```bash
npm run dist:mac
```

This creates a `.dmg` and `.zip` in `dist/`. Local unsigned builds may trigger Gatekeeper when opened on another Mac; signing and notarization require your Apple Developer certificate and credentials and are intentionally not configured in this repository.

### Windows installer

Windows uses the built-in terminal fallback (PowerShell); `tmux` persistence is
not required or used on Windows. From a Windows machine, build a 64-bit NSIS
installer with:

```powershell
npm install
npm run dist:win
```

The installable executable is written to `dist/Agent Terminal IDE-<version>-Setup.exe`.
It lets the user choose an installation folder and creates Start Menu and desktop shortcuts.
Windows SmartScreen may show a warning for this unsigned build. Code signing is
needed before distributing the installer broadly.

---

## End-to-end smoke test

The smoke suite launches Electron through Playwright, verifies the initial four-pane grid, writes `echo hello-sandbox-test` through the real `node-pty` bridge, verifies that killing a pane kills its `ide-*` tmux session, then restarts Electron and reattaches a surviving session.

```bash
# Linux/headless CI
xvfb-run -a npm run test:smoke
```

On macOS, Xvfb is not used. Run the test from an interactive signed-in desktop session so Electron can connect to the native WindowServer:

```bash
npm run test:smoke
```

The test requires a functioning Electron binary, `tmux`, and Xvfb. It cleans up its `ide-*` tmux sessions on success. If it is interrupted, run `tmux list-sessions` and `tmux kill-session -t <name>` for any remaining test session.

---

## Project Structure

```
.
├── config/
│   └── agents.json          # CLI Agent presets configuration
├── main/
│   ├── index.js             # Electron main process entry point
│   ├── pty-manager.js       # node-pty + tmux session engine & orphan scanner
│   ├── agent-config.js      # Presets loader & storage sync
│   ├── workspace-store.js   # Local JSON storage for workspace presets
│   └── ipc-handlers.js      # Secure IPC endpoint registrations
├── preload/
│   └── index.js             # Preload script exposing contextBridge APIs
├── renderer/
│   ├── index.html           # Main UI structure & modals
│   ├── styles.css           # Modern dark-mode styling & grid CSS
│   ├── pane.js              # xterm.js pane component wrapper
│   ├── grid.js              # Grid layout manager (2x3 / 3x2)
│   ├── broadcast.js         # Broadcast mode input multiplexer
│   └── app.js               # Application state coordinator
├── package.json             # App manifest & electron-builder config
└── README.md                # Project documentation
```

---

## License

Distributed under the MIT License. See `LICENSE` for details.
