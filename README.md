# Interactive Shell MCP — with Live Viewer

MCP server that provides interactive shell session management
with full terminal emulation support via node-pty, **plus a live
browser viewer** that lets a human watch — and take over — the
exact shell sessions the AI is driving, in real time.

> This is a fork/extension of
> [lightos/interactive-shell-mcp](https://github.com/lightos/interactive-shell-mcp)
> by Roberto Salgado. The original MCP server and all its shell-session
> tooling are his work; this repository adds the live browser viewer
> (`src/viewer.ts` + `viewer/`) on top. Licensed MIT, same as the
> upstream project — see [LICENSE](./LICENSE).

## Overview

The Interactive Shell MCP (Model Context Protocol) server enables
LLMs to create and manage interactive shell sessions. It provides
persistent shell environments where commands can be executed
sequentially while maintaining state, similar to how a human
would use a terminal.

The problem this fork solves: when an AI runs commands inside one
of these PTY sessions, a human normally has **no way to see what is
happening** — node-pty spawns a hidden child process with no
human-attachable endpoint. The live viewer fixes that by
broadcasting the exact PTY stream the AI consumes to a browser
terminal (xterm.js) over a local WebSocket, and forwarding the
browser's keystrokes back into the same PTY. The result is a shared
session, much like `screen -x` / `tmux attach`, but **Windows-native**
(ConPTY) with no WSL, tmux, screen, or MSYS2 required.

## Features

- Create and manage multiple concurrent shell sessions
- Full terminal emulation with proper TTY support
- Persistent shell state across commands
- Support for interactive programs (vim, nano, etc.)
- Cross-platform support (bash on Unix/Linux/macOS,
  PowerShell on Windows)
- Smart output handling with automatic mode detection
- Snapshot mode for continuously updating terminal applications
- Raw input mode for interactive selection prompts
- Configurable output size limits to prevent memory overflow
- Automatic detection of terminal control sequences
- **Live browser viewer** — watch every session live, take
  over the keyboard at any time, and end any session straight
  from the sidebar (Windows-native, no WSL/tmux)

## Available Tools

### `start_shell_session`

Spawns a new PTY shell and returns a unique session ID.

- **Input**: None
- **Output**: `{ sessionId: string }`

### `send_shell_input`

Writes input to the PTY. Appends a carriage return by default.
Set `raw: true` for interactive prompts (arrow keys, space
to toggle, etc.).

- **Input**:
  - `sessionId` (string): The session ID of the shell
  - `input` (string): The input to send to the shell
  - `raw` (boolean, optional): Send input without appending
    carriage return. Interprets escape sequences
    (`\x1b`, `\r`, `\n`, `\t`, `\e`).
- **Output**: Success confirmation

### `read_shell_output`

Returns output from the PTY process with support for two modes:

- **Streaming mode** (default): Returns buffered output since
  last read and clears the buffer
- **Snapshot mode**: Returns the current terminal screen state
  without clearing (ideal for apps like top, htop, airodump-ng)

- **Input**:
  - `sessionId` (string): The session ID of the shell
  - `mode` (string, optional): Output mode - "streaming"
    (default) or "snapshot"
  - `maxBytes` (number, optional): Maximum bytes to return
    (default: 100KB, max: 1MB)
  - `snapshotSize` (number, optional): Size of the snapshot
    buffer to capture (default: 50KB)
- **Output**:

  ```json
  {
    "output": "string",
    "metadata": {
      "mode": "streaming|snapshot",
      "totalBytesReceived": 0,
      "truncated": false,
      "originalSize": 0,
      "isSnapshot": false,
      "snapshotTime": 0
    }
  }
  ```

### `end_shell_session`

Closes the PTY and cleans up resources.

- **Input**:
  - `sessionId` (string): The session ID of the shell to close
- **Output**: Success confirmation

## Installation

```bash
npm install
npm run build
```

## MCP Configuration

To use this MCP server with Claude Desktop or VS Code, add the
following configuration to your MCP settings file:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "Interactive Shell MCP": {
      "command": "node",
      "args": [
        "/path/to/interactive-shell-mcp/dist/server.js"
      ]
    }
  }
}
```

### VS Code (Cursor)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "Interactive Shell MCP": {
      "command": "node",
      "args": [
        "/path/to/interactive-shell-mcp/dist/server.js"
      ]
    }
  }
}
```

Replace `/path/to/interactive-shell-mcp` with the actual path
to your installation.

## Usage Examples

**Note:** The examples below demonstrate how an LLM would
interact with this MCP server. These are not JavaScript code
to be run directly, but rather illustrate the expected tool
calling patterns.

### Working with High-Output Commands

When working with commands that produce large outputs or
continuously refresh the screen (like `airodump-ng`, `htop`,
`top`), use snapshot mode:

```javascript
// Example of how an LLM would call these tools:
// Start a session
const { sessionId } = await start_shell_session();

// Run airodump-ng
await send_shell_input(sessionId, "sudo airodump-ng wlan0mon");

// Read output in snapshot mode to get current screen state
const result = await read_shell_output(sessionId, {
  mode: "snapshot"
});
```

### Handling Regular Commands

For normal commands that produce streaming output:

```javascript
// Example of how an LLM would call these tools:
// Use default streaming mode
const output = await read_shell_output(sessionId);

// Or explicitly set a size limit for very large outputs
const output = await read_shell_output(sessionId, {
  maxBytes: 50000  // Return only last 50KB
});
```

### Interacting with Selection Prompts

For interactive prompts (like `db:push`, inquirer, etc.):

```javascript
// Use raw mode to send arrow keys and enter
await send_shell_input(sessionId, "\x1b[B", { raw: true });
await send_shell_input(sessionId, "\r", { raw: true });
```

## Output Modes Explained

- **Streaming Mode**: Best for regular commands. Returns all
  output since last read and clears the buffer.
- **Snapshot Mode**: Best for continuously updating applications.
  Returns the current terminal screen state without clearing.

## Debugging

To run the server independently for debugging:

```bash
npm start
```

This will start the server on stdio, which is primarily useful
for testing the installation and debugging issues.

## Live Viewer

When the MCP server starts, it also launches a small HTTP +
WebSocket server bound to `127.0.0.1`, gated by a random token.
Open the printed URL in any browser to watch the AI's shell
sessions live and type into them yourself.

### How it works

- Every byte the AI's PTY emits (`pty.onData`) is broadcast to
  connected browsers and rendered with [xterm.js](https://xtermjs.org/).
- Keystrokes you type in the browser are sent back over the
  WebSocket and written into the **same** PTY (`pty.write`), so the
  AI and the human share one live session — like `screen -x`.
- A rolling replay buffer (last 256 KB per session) is sent to any
  viewer that attaches mid-session, so you see recent scrollback
  immediately.
- **End a session from the browser** — every session in the sidebar
  has an `✕` button. Clicking it (after a confirm prompt) kills that
  PTY: the request is routed to the MCP instance that owns the
  session, and the child process tree is reaped, so the entry
  disappears for every connected viewer.
- Bound to `127.0.0.1` only and protected by a per-process token;
  the viewer is never exposed off the local machine.

This is especially useful for steps the AI should **not** see or
handle — e.g. typing an SSH password or a 2FA code: attach the
session in the browser, type the secret yourself, and the AI only
ever sees the resulting prompt, never the secret.

### Getting the URL

On startup the server prints the viewer URL to stderr and also
writes it to `viewer-url.txt` (git-ignored, since it contains the
token):

```
[viewer] live terminal at http://127.0.0.1:7682/?token=<random>
```

Open that URL, pick a session from the sidebar, and start watching.
Click into the terminal and type to take over.

### Configuration

The viewer is controlled entirely by environment variables — set
them in the `env` block of your MCP server configuration:

| Variable | Default | Description |
|----------|---------|-------------|
| `ISH_VIEWER_PORT` | `7682` | Base port; if busy, tries up to +8. |
| `ISH_VIEWER_TOKEN` | random per start | Fixed token for a stable URL. |
| `ISH_VIEWER_DISABLE` | unset | Set to `1` to disable the viewer entirely. |

Example MCP configuration with a stable port and token:

```json
{
  "mcpServers": {
    "Interactive Shell MCP": {
      "command": "node",
      "args": ["/path/to/interactive-shell-mcp-viewer/dist/server.js"],
      "env": {
        "ISH_VIEWER_PORT": "7682",
        "ISH_VIEWER_TOKEN": "your-fixed-token-here"
      }
    }
  }
}
```

With a fixed token the viewer URL never changes, so you can
bookmark `http://127.0.0.1:7682/?token=your-fixed-token-here`.

## Credits

- Original [interactive-shell-mcp](https://github.com/lightos/interactive-shell-mcp)
  by [Roberto Salgado (lightos)](https://github.com/lightos).
- Live viewer addition by [twmoon](https://github.com/twmoon).

## License

MIT — see [LICENSE](./LICENSE). Original work © 2025 Roberto Salgado;
live viewer additions © 2026 twmoon.
