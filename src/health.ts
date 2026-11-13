import http from "node:http";

const port = Number(process.env.HEALTH_PORT || 8000);

http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/health") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ ok: true, service: "amocrm-tunnel-health" }));
}).listen(port, "0.0.0.0", () => {
  console.log(`Health endpoint listening on 0.0.0.0:${port}`);
});
