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
installing version 14, launch **ORION IDE 14** and confirm the window title shows
**v14.0.0**. The app keeps its existing application data location. Builds validate
the packaged marketplace code and reject the obsolete blocked-install UI before
creating an installer. Version 14 also fixes Windows Explorer file creation
refresh, external editor file updates, and Run Agent command/folder synchronization,
and includes the WebSocket runtime dependency required for JavaScript debugging.

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

Production trust is pinned in `config/update-keys.json` as an Ed25519 public PEM
and its SHA-256 SPKI DER key ID:
`279edf884548fa316ee4f96117e547953df6ae22854a0a7a0baf159c45b0fbf8`.
The public key comes from the saved production trust record, independently of
update API responses. electron-builder includes this configuration in `app.asar`;
the packaging check rejects missing, invalid, or mismatched trust anchors. Only
the public verification key belongs in Orion; signing credentials remain on
release infrastructure. No key is trusted from an API response. Development overrides
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

Linux x64 releases include a portable **AppImage** for Fedora Workstation and
Debian, a **RPM installer** for Fedora, a **DEB installer** for Debian/Ubuntu,
and a tar.gz archive. Node.js is only needed when building from source.

### Install on Fedora Workstation

```bash
sudo dnf install ./agent-terminal-ide-14.0.0-x86_64.rpm
```

### Install on Debian / Ubuntu

```bash
sudo apt install ./agent-terminal-ide-14.0.0-amd64.deb
```

Both installers add ORION IDE to the application launcher and install `tmux`
for persistent terminal sessions.

### Portable AppImage on either distribution

```bash
chmod +x agent-terminal-ide-14.0.0-x86_64.AppImage
./agent-terminal-ide-14.0.0-x86_64.AppImage
```

Install `tmux` separately for persistent sessions (`sudo dnf install tmux` on
Fedora or `sudo apt install tmux` on Debian). If FUSE 2 is unavailable, run:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./agent-terminal-ide-14.0.0-x86_64.AppImage
```

### Build all Linux packages

Build on Linux with Node.js 22 or newer and native build tools. Use Debian 12
or Ubuntu 22.04 as the build environment for compatibility with older glibc
versions; a native Fedora build may require a newer glibc on the target machine.

```bash
# Debian / Ubuntu build tools
sudo apt install build-essential python3 rpm
# Fedora build tools (when building natively on Fedora)
sudo dnf install gcc-c++ make python3 rpm-build

npm ci
bash build-linux.sh
```

The script rebuilds `node-pty` for the installed Electron version and writes
AppImage, DEB, RPM, tar.gz, and `SHA256SUMS-14.0.0-linux.txt` to `dist/`.
Verify downloaded artifacts with `sha256sum -c SHA256SUMS-14.0.0-linux.txt`
from that directory.

The **Build Linux Packages** GitHub Actions workflow builds all four formats.
Manual runs upload the `linux-packages-x64` artifact; version tags also attach
the packages and checksums to a GitHub Release.

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

The installable executable is written to `dist/ORION IDE-<version>-Setup.exe`.
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
