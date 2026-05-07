import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 3000);
const storeDir = process.env.TGCLI_STORE || "/data";
const tgcliHost = process.env.TGCLI_HOST || "127.0.0.1";
const tgcliPort = Number(process.env.TGCLI_PORT || 8080);
const bearerToken = process.env.MCP_BEARER_TOKEN || "";

const configPath = path.join(storeDir, "config.json");
const sessionPath = path.join(storeDir, "session.json");

let child = null;
let childReady = false;
let lastStartAttempt = 0;

function hasTelegramStore() {
  return fs.existsSync(configPath) && fs.existsSync(sessionPath);
}

function ensureTgcliMcpConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`[proxy] failed to read tgcli config: ${error.message}`);
    return false;
  }

  const nextConfig = {
    ...config,
    mcp: {
      ...(config.mcp && typeof config.mcp === "object" ? config.mcp : {}),
      enabled: true,
      host: tgcliHost,
      port: tgcliPort,
    },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return true;
}

function ensureTgcli() {
  if (child || !hasTelegramStore()) return;

  const now = Date.now();
  if (now - lastStartAttempt < 5000) return;
  lastStartAttempt = now;

  if (!ensureTgcliMcpConfig()) return;

  childReady = false;
  child = spawn("./node_modules/.bin/tgcli", ["server"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      TGCLI_STORE: storeDir,
      MCP_HOST: tgcliHost,
      MCP_PORT: String(tgcliPort),
    },
  });

  child.once("exit", (code, signal) => {
    console.error(`[tgcli] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    child = null;
    childReady = false;
  });
}

function unauthorized(res) {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": "Bearer",
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function requireBearer(req, res) {
  if (!bearerToken) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "MCP_BEARER_TOKEN is not configured" }));
    return false;
  }
  if (req.headers.authorization !== `Bearer ${bearerToken}`) {
    unauthorized(res);
    return false;
  }
  return true;
}

function proxyToTgcli(req, res) {
  if (!hasTelegramStore()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "telegram session is not installed yet" }));
    return;
  }

  ensureTgcli();

  const upstreamReq = http.request(
    {
      host: tgcliHost,
      port: tgcliPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `${tgcliHost}:${tgcliPort}`,
      },
    },
    (upstreamRes) => {
      childReady = true;
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (error) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tgcli is not ready", detail: error.message }));
  });

  req.pipe(upstreamReq);
}

function health(res) {
  ensureTgcli();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      telegramStoreInstalled: hasTelegramStore(),
      tgcliProcessRunning: Boolean(child),
      tgcliReady: childReady,
    }),
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    health(res);
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (!requireBearer(req, res)) return;
  proxyToTgcli(req, res);
});

setInterval(ensureTgcli, 5000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`[proxy] listening on 0.0.0.0:${port}`);
  console.log(`[proxy] protected MCP endpoint: /mcp`);
});

function shutdown() {
  if (child) child.kill("SIGTERM");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
