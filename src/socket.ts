#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// Track every connected socket (even before channel join) for heartbeat
const allClients = new Set<ServerWebSocket<any>>();

function handleConnection(ws: ServerWebSocket<any>) {
  // Don't add to clients immediately - wait for channel join
  console.log("New client connected");
  allClients.add(ws);

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));
}

// Heartbeat: protocol-level ping every 30s keeps connections alive
// (Bun closes sockets idle longer than `idleTimeout`). Sockets that miss a
// pong or that stopped sending app-level heartbeats (a suspended plugin
// iframe still auto-pongs at TCP level, so ping alone cannot detect it)
// are terminated instead of lingering until `idleTimeout`.
setInterval(() => {
  const now = Date.now();
  for (const client of allClients) {
    try {
      if (client.readyState !== WebSocket.OPEN) {
        allClients.delete(client);
        continue;
      }
      const data = client.data as { alive?: boolean; lastHeartbeat?: number } | undefined;
      // A client that once sent app heartbeats must keep doing so — silence
      // means its JS is frozen, not that the socket is dead
      if (data?.lastHeartbeat && now - data.lastHeartbeat > 90_000) {
        console.log("Terminating client: app heartbeat silent >90s");
        client.terminate();
        continue;
      }
      if (data && data.alive === false) {
        console.log("Terminating client: no pong since last ping");
        client.terminate();
        continue;
      }
      if (data) {
        data.alive = false;
      }
      client.ping();
    } catch {
      allClients.delete(client);
    }
  }
}, 30_000);

// Only allow WebSocket upgrades from the Figma plugin (Origin: "null"),
// local tooling without an Origin header, or localhost pages.
// This blocks arbitrary websites from driving the plugin via the browser.
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (origin === null || origin === "null") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

const server = Bun.serve({
  port: 3055,
  // Bind to loopback only — the relay must not be reachable from the LAN.
  hostname: "127.0.0.1",
  fetch(req: Request, server: Server) {
    if (!isAllowedOrigin(req)) {
      return new Response("Forbidden origin", { status: 403 });
    }

    // Handle WebSocket upgrade
    const success = server.upgrade(req, {
      data: { alive: true, lastHeartbeat: 0 },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running");
  },
  websocket: {
    // Max allowed idle timeout (default is 120s). Heartbeat pings above
    // keep sockets active, so this only fires for truly dead peers.
    idleTimeout: 960,
    open: handleConnection,
    pong(ws: ServerWebSocket<any>) {
      // Protocol-level proof the peer is alive
      if (ws.data) {
        ws.data.alive = true;
      }
    },
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        if (ws.data) {
          ws.data.alive = true;
        }
        const data = JSON.parse(message as string);
        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        // App-level heartbeat from the Figma plugin: proves its JS is running
        // (a suspended iframe keeps answering TCP pings but cannot send this)
        if (data.type === "heartbeat") {
          if (ws.data) {
            ws.data.lastHeartbeat = Date.now();
          }
          return;
        }

        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              console.log(`\n=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          
          if (broadcastCount === 0) {
            console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
            // Fail the request immediately instead of letting the sender hang
            // until its own timeout — the plugin is not in the channel anyway
            if (data.id) {
              ws.send(JSON.stringify({
                id: data.id,
                type: "message",
                channel: channelName,
                message: {
                  id: data.id,
                  error: `No Figma plugin connected to channel "${channelName}" (open the plugin window and press Connect)`,
                },
              }));
            }
          } else {
            console.log(`✓ Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      console.log("Client disconnected");
      allClients.delete(ws);

      // Remove client from their channel and notify peers
      channels.forEach((clients, channelName) => {
        if (clients.has(ws)) {
          clients.delete(ws);

          clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A user has left the channel",
                channel: channelName
              }));
            }
          });
        }
      });
    }
  }
});

console.log(`WebSocket server running on port ${server.port}`);
