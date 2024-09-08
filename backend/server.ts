#!/usr/bin/env -S deno run --allow-net --allow-read --allow-run
const pingHost = "example.com"; // Replace with the host you want to ping

Deno.serve({ port: 3000 }, async (req) => {
  const path = new URL(req.url).pathname;

  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);

    console.log("New WebSocket connection");

    socket.addEventListener("open", () => {
      console.log("WebSocket connection opened");

      const pingInterval = setInterval(async () => {
        try {
          const start = performance.now();
          const process = new Deno.Command("ping", {
            args: ["-c", "1", pingHost],
            stdout: "piped",
            stderr: "piped",
          });
          await process.spawn().status;
          const end = performance.now();
          const pingTime = Math.round(end - start);

          socket.send(JSON.stringify({ ping: pingTime }));
        } catch (error) {
          console.error("Error pinging:", error);
        }
      }, 1000);

      socket.addEventListener("close", () => {
        console.log("WebSocket connection closed");
        clearInterval(pingInterval);
      });
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
