#!/usr/bin/env bun

// src/socket.ts
var channels = /* @__PURE__ */ new Map();
var allClients = /* @__PURE__ */ new Set();
function handleConnection(ws) {
  console.log("New client connected");
  allClients.add(ws);
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting"
  }));
}
setInterval(() => {
  const now = Date.now();
  for (const client of allClients) {
    try {
      if (client.readyState !== WebSocket.OPEN) {
        allClients.delete(client);
        continue;
      }
      const data = client.data;
      if (data?.lastHeartbeat && now - data.lastHeartbeat > 9e4) {
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
}, 3e4);
function isAllowedOrigin(req) {
  const origin = req.headers.get("Origin");
  if (origin === null || origin === "null") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
var server = Bun.serve({
  port: 3055,
  // Bind to loopback only — the relay must not be reachable from the LAN.
  hostname: "127.0.0.1",
  fetch(req, server2) {
    if (!isAllowedOrigin(req)) {
      return new Response("Forbidden origin", { status: 403 });
    }
    const success = server2.upgrade(req, {
      data: { alive: true, lastHeartbeat: 0 }
    });
    if (success) {
      return;
    }
    return new Response("WebSocket server running");
  },
  websocket: {
    // Max allowed idle timeout (default is 120s). Heartbeat pings above
    // keep sockets active, so this only fires for truly dead peers.
    idleTimeout: 960,
    open: handleConnection,
    pong(ws) {
      if (ws.data) {
        ws.data.alive = true;
      }
    },
    message(ws, message) {
      try {
        if (ws.data) {
          ws.data.alive = true;
        }
        const data = JSON.parse(message);
        console.log(`
=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || "N/A"}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));
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
          if (!channels.has(channelName)) {
            channels.set(channelName, /* @__PURE__ */ new Set());
          }
          const channelClients = channels.get(channelName);
          channelClients.add(ws);
          console.log(`
\u2713 Client joined channel "${channelName}" (${channelClients.size} total clients)`);
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));
          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName
            },
            channel: channelName
          }));
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
              console.log(`
=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          if (broadcastCount === 0) {
            console.log(`\u26A0\uFE0F  No other clients in channel "${channelName}" to receive message!`);
            if (data.id) {
              ws.send(JSON.stringify({
                id: data.id,
                type: "message",
                channel: channelName,
                message: {
                  id: data.id,
                  error: `No Figma plugin connected to channel "${channelName}" (open the plugin window and press Connect)`
                }
              }));
            }
          } else {
            console.log(`\u2713 Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
          }
        }
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
    close(ws) {
      console.log("Client disconnected");
      allClients.delete(ws);
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
//# sourceMappingURL=socket.js.map