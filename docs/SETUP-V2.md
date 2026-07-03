# Morph (figma-write v2) — Machine Setup

One-time setup per machine (desktop or laptop). v2 adds file-key routing: with
several Figma files open, every tool call can target an exact file, and the
server refuses to guess when the target is ambiguous.

## 1. Clone and build

```bash
git clone https://github.com/JayKapoor/morph.git
cd morph
git checkout v2-filekey
npm install
npm run build
```

## 2. Run the server

Foreground (for a first test):

```bash
node dist/index.js
```

macOS LaunchAgent (start at login, keep alive), save as
`~/Library/LaunchAgents/com.jaykapoor.figma-mcp-write-server.plist` and adjust
the repo path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jaykapoor.figma-mcp-write-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/PATH/TO/figma-mcp-write-server/dist/index.js</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.jaykapoor.figma-mcp-write-server.plist
curl -s http://localhost:3100/health   # expect status ok + connectedFiles
```

## 3. Import the Figma plugin

In the Figma desktop app: **Plugins → Development → Import plugin from
manifest…** and pick `figma-plugin/manifest.json` from the clone. Run the
plugin (once per file you want editable). The UI scans ports 8765-8774, so it
finds the server even if the default port was taken, and reconnects on its own
after server restarts.

## 4. Point Claude at it

```bash
claude mcp add figma-write -s user --transport http http://localhost:3100/mcp
```

## Using file-key routing

- `figma_files` lists connected files with their `fileKey`.
- Every tool takes an optional `fileKey`. One file connected: omit it. Several:
  pass it (calls without it fail loudly instead of hitting the wrong file).
- `figma_execute` runs raw Plugin API JavaScript in the target file for
  anything the typed tools do not cover. Top-level `await` and `return` work.

## Upgrading a machine

```bash
cd morph
git pull
npm install && npm run build
launchctl unload ~/Library/LaunchAgents/com.jaykapoor.figma-mcp-write-server.plist
launchctl load   ~/Library/LaunchAgents/com.jaykapoor.figma-mcp-write-server.plist
```

Restarting the server invalidates live Claude MCP sessions; restart the Claude
Code session afterward. In Figma, plugins reconnect automatically.
