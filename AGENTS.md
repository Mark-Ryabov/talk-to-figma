# Talk to Figma MCP — Setup & Usage Guide

MCP integration that lets an AI agent (Cursor, Windsurf, Cascade, Claude Code)
read and modify Figma designs. This repository is a hardened fork of
[sonnylazuardi/cursor-talk-to-figma-mcp](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp)
(MIT license).

## How it works

Three components talk to each other:

```
AI agent  --stdio-->  MCP server  --WebSocket :3055-->  Figma plugin (iframe)
                      (this repo, dist/server.js)        (src/cursor_mcp_plugin)
```

- **MCP server** (`src/talk_to_figma_mcp/server.ts`) — exposes tools over stdio.
  On startup it makes sure the WebSocket relay is running: it adopts an already
  running relay on port `3055` or spawns one as a child process. You never need
  to start the relay manually.
- **WebSocket relay** (`src/socket.ts`) — a tiny Bun server on `127.0.0.1:3055`
  that routes messages between the MCP server and the plugin, grouped into
  named channels.
- **Figma plugin** (`src/cursor_mcp_plugin`) — runs inside Figma, connects to
  the relay, joins a channel and executes the actual Figma API calls.

## Differences from upstream

- **No Google Analytics** — all tracking code and the
  `google-analytics.com` network permission removed.
- **Relay auto-spawn** — the MCP server starts the socket relay itself and
  resolves `bun` by absolute paths (`~/.bun/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`) so it works when launched from a GUI IDE with a stripped
  `PATH`.
- **Auto-reconnect** — dropped connections are re-established automatically,
  and the last channel is rejoined transparently.
- **Hardened relay** — binds to loopback only, validates the `Origin` header,
  watchdog that terminates frozen clients (protocol ping + app heartbeat),
  instant "no plugin in channel" error instead of a hanging timeout.
- **Persistent plugin settings** — port and channel name are stored in
  `clientStorage`; the plugin auto-connects on open and reuses the channel.

## Installation

Prerequisites: [Bun](https://bun.sh) and the Figma desktop app.

```bash
git clone https://github.com/Mark-Ryabov/talk-to-figma.git
cd talk-to-figma
bun install
bun run build
```

A prebuilt `dist/` is committed to the repo, so the build step is optional
unless you change the sources.

## Connecting the MCP server

Point your IDE's MCP config at `dist/server.js` (absolute path):

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": ["/absolute/path/to/talk-to-figma/dist/server.js"]
    }
  }
}
```

- Cursor: `~/.cursor/mcp.json`
- Windsurf / Cascade: `~/.codeium/mcp_config.json`

The relay starts automatically — no separate `bun socket` step needed.
Reload the MCP servers / restart the IDE after editing the config.

## Installing the Figma plugin

Do **not** use the community plugin from the Figma catalog — this fork uses an
extended protocol (heartbeats, persisted channel, auto-connect).

1. In Figma: **Plugins → Development → Import plugin from manifest…**
2. Select `src/cursor_mcp_plugin/manifest.json` from this repo.
3. The plugin appears under **Plugins → Development → Cursor Talk to Figma MCP Plugin**.

## Using it — session workflow

### 1. Keep the plugin window open (required)

The plugin runs inside a Figma iframe. **The plugin window must stay open in
Figma for the entire session** — closing it kills the WebSocket connection,
and every MCP call will immediately fail with
`No Figma plugin connected to channel`. Minimizing is fine; closing is not.

### 2. Connect and copy the channel name

1. Open the plugin in the Figma file you want to work with.
2. Press **Connect** (or wait for auto-connect).
3. The status line shows
   `Connected to server in channel: <channel-name>` — **copy the channel
   name** and give it to the agent, e.g. *"join channel abc123"*.
4. The agent calls `join_channel` with that name. All subsequent commands go
   through this channel.

The channel name is generated once and persisted — after reopening the plugin
the same channel is reused, so a reconnecting agent finds it again.
(The plugin's **Copy to Clipboard** button copies the `mcp.json` config
snippet, not the channel name — the channel name is copied from the status
line.)

### 3. Point the agent at nodes

Two ways to tell the agent what to work on:

- **Selection** — select the frame/node in the open Figma file, then ask the
  agent to `read_my_design` or `get_selection`. Simplest and most common.
- **Copy link to selection** — right-click a node →
  **Copy/Paste as → Copy link to selection**, paste the URL into the chat.
  The node ID lives in the `node-id` URL parameter; `1234-5678` in the URL
  corresponds to `1234:5678` in `get_node_info` / `export_node_as_image` etc.

### 4. View-only design files: copy into your own workspace first

The plugin executes with your Figma permissions. In a designer's file where
you only have **view** access the plugin cannot run properly — commands fail
and `Copy link to selection` leads nowhere useful. Workaround:

1. **File → Duplicate to your drafts** (or select the frames and copy-paste
   them into a file inside your own workspace).
2. Open the plugin inside **your copy** of the file.
3. Now selection reads and `Copy link to selection` produce node IDs the
   agent can actually fetch.

### 5. Typical first calls

```
join_channel(channel: "<name from plugin status>")
get_document_info()        // overview of pages/top-level frames
read_my_design()           // deep dump of the current selection
```

## Available tools

44 tools, grouped:

- **Document & selection**: `get_document_info`, `get_selection`,
  `read_my_design`, `get_node_info`, `get_nodes_info`, `set_focus`,
  `set_selections`
- **Annotations**: `get_annotations`, `set_annotation`,
  `set_multiple_annotations`, `scan_nodes_by_types`
- **Prototyping**: `get_reactions`, `set_default_connector`,
  `create_connections`
- **Creating**: `create_rectangle`, `create_frame`, `create_section`,
  `create_text`, `create_component_instance`, `clone_node`
- **Text**: `scan_text_nodes`, `set_text_content`,
  `set_multiple_text_contents`
- **Auto-layout**: `set_layout_mode`, `set_padding`, `set_axis_align`,
  `set_layout_sizing`, `set_item_spacing`
- **Styling**: `set_fill_color`, `set_stroke_color`, `set_corner_radius`,
  `set_image_fill`
- **Layout & organization**: `move_node`, `resize_node`, `delete_node`,
  `delete_multiple_nodes`, `rename_node`, `set_parent`
- **Components & styles**: `get_styles`, `get_local_components`,
  `get_instance_overrides`, `set_instance_overrides`
- **Export**: `export_node_as_image` (PNG, JPG, SVG, PDF)
- **Connection**: `join_channel`

MCP prompts included: `design_strategy`, `read_design_strategy`,
`text_replacement_strategy`, `annotation_conversion_strategy`,
`swap_overrides_instances`, `reaction_to_connector_strategy`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No Figma plugin connected to channel` | Plugin window is closed or hasn't joined — open it, press Connect, confirm the channel name |
| `Must join a channel before sending commands` | Agent called a tool before `join_channel` — call it first with the channel from the plugin status line |
| Commands succeed but nothing changes | The agent is talking to a stale channel or the plugin is in a different file — check the file tab the plugin was opened in |
| Plugin can't read / copy-link nodes fail | You have view-only access — duplicate the file into your drafts and work on the copy |
| Relay/port issues | Only one relay can listen on `3055`; a second instance is adopted automatically. `bun` must be locatable via `PATH`, `BUN_INSTALL`, `~/.bun/bin`, `/opt/homebrew/bin` or `/usr/local/bin` |
| Plugin frozen / unresponsive | The relay terminates clients silent for >90s — reopen the plugin; it auto-connects and rejoins the saved channel |

## Repository layout

```
src/talk_to_figma_mcp/server.ts   MCP server (stdio, tool definitions)
src/socket.ts                     WebSocket relay on 127.0.0.1:3055
src/cursor_mcp_plugin/            Figma plugin: manifest.json, code.js, ui.html
dist/                             prebuilt bundles (committed)
```

## License

MIT — see `LICENSE`. Copyright retained from the upstream project.
