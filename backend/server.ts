#!/usr/bin/env -S deno run --allow-net --allow-read --allow-run=ping
const pingHost = "8.8.8.8";

async function* pingGenerator() {
  const process = new Deno.Command("ping", {
    args: [pingHost],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const reader = process.stdout.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const output = new TextDecoder().decode(value);
    const match = output.match(/time=(\d+(\.\d+)?)/);
    if (match) {
      yield parseFloat(match[1]);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

Deno.serve({ port: 3000 }, async (req) => {
  const path = new URL(req.url).pathname;

  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);

    console.log("New WebSocket connection");

    socket.addEventListener("open", async () => {
      console.log("WebSocket connection opened");

      for await (const pingTime of pingGenerator()) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ ping: pingTime }));
        } else {
          break;
        }
      }
    });

    socket.addEventListener("close", () => {
      console.log("WebSocket connection closed");
    });

    return response;
  }

  if (path === "/" || path === "/index.html") {
    return new Response(await Deno.readTextFile("./frontend/index.html"), {
      headers: { "content-type": "text/html" },
    });
  }

  return new Response("Not Found", { status: 404 });
});

console.log("Server running on http://localhost:3000");
