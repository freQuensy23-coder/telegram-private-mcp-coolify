import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const port = Number(process.env.PORT || 3000);
const storeDir = process.env.TGCLI_STORE || "/data";
const tgcliHost = process.env.TGCLI_HOST || "127.0.0.1";
const tgcliPort = Number(process.env.TGCLI_PORT || 8080);
const bearerToken = process.env.MCP_BEARER_TOKEN || "";
const publicPrefix = normalizePrefix(process.env.MCP_PUBLIC_PREFIX || "");
const oauthClientId = process.env.OAUTH_CLIENT_ID || "";
const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET || "";
const authPassword = process.env.MCP_AUTH_PASSWORD || "";

const configPath = path.join(storeDir, "config.json");
const sessionPath = path.join(storeDir, "session.json");

let child = null;
let childReady = false;
let lastStartAttempt = 0;

// code -> { codeChallenge, codeChallengeMethod, redirectUri, clientId, resource, expiresAt }
const pendingCodes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pendingCodes) {
    if (now > data.expiresAt) pendingCodes.delete(code);
  }
}, 60_000).unref();

function normalizePrefix(prefix) {
  const normalized = prefix.trim().replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function hasTelegramStore() {
  return fs.existsSync(configPath) && fs.existsSync(sessionPath);
}

function ensureTelegramStore() {
  if (hasTelegramStore()) return true;

  const apiId = process.env.TELEGRAM_API_ID || process.env.TG_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH || process.env.TG_API_HASH;
  const phoneNumber = process.env.TELEGRAM_PHONE || process.env.TG_PHONE || "";
  const sessionString = process.env.TELEGRAM_SESSION_STRING || process.env.TG_SESSION_STRING;

  if (!apiId || !apiHash || !sessionString) return false;

  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        apiId: String(apiId),
        apiHash: String(apiHash),
        phoneNumber: String(phoneNumber),
        mcp: { enabled: true, host: tgcliHost, port: tgcliPort },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const importScript = `
    import { TelegramClient } from '@mtcute/node';
    import { writeStringSession } from '@mtcute/core/utils.js';
    import { convertFromTelethonSession, convertFromPyrogramSession } from '@mtcute/convert';
    const client = new TelegramClient({
      apiId: Number(process.env.TELEGRAM_API_ID || process.env.TG_API_ID),
      apiHash: process.env.TELEGRAM_API_HASH || process.env.TG_API_HASH,
      storage: process.env.TGCLI_SESSION_PATH,
      disableUpdates: true,
    });
    const session = process.env.TELEGRAM_SESSION_STRING || process.env.TG_SESSION_STRING;
    try {
      await client.importSession(session, true);
    } catch (error) {
      let imported = false;
      for (const convert of [convertFromTelethonSession, convertFromPyrogramSession]) {
        try {
          await client.importSession(writeStringSession(convert(session)), true);
          imported = true;
          break;
        } catch (_) {}
      }
      if (!imported) throw error;
    }
    await client.destroy();
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], {
    cwd: process.cwd(),
    env: { ...process.env, TGCLI_SESSION_PATH: sessionPath },
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    console.error(`[proxy] failed to import Telegram session string, exit=${result.status}`);
    return false;
  }

  return hasTelegramStore();
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

function patchTgcliStartup() {
  const mcpServerPath = path.join(process.cwd(), "node_modules", "@kfastov", "tgcli", "mcp-server.js");
  try {
    let source = fs.readFileSync(mcpServerPath, "utf8");
    const blockingInit = `await initializeTelegram().catch((error) => {
  console.error(\`[startup] Telegram initialization failed: \${error?.message ?? error}\`);
  process.exit(1);
});`;
    const backgroundInit = `initializeTelegram().catch((error) => {
  console.error(\`[startup] Telegram initialization failed: \${error?.message ?? error}\`);
});`;
    if (source.includes(blockingInit)) {
      source = source.replace(blockingInit, backgroundInit);
      fs.writeFileSync(mcpServerPath, source, "utf8");
    }
  } catch (error) {
    console.error(`[proxy] failed to patch tgcli startup: ${error.message}`);
  }
}

function ensureTgcli() {
  if (child || !ensureTelegramStore()) return;

  const now = Date.now();
  if (now - lastStartAttempt < 5000) return;
  lastStartAttempt = now;

  if (!ensureTgcliMcpConfig()) return;
  patchTgcliStartup();

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

function unauthorized(req, res) {
  const metadataUrl = getProtectedResourceMetadataUrl(req);
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="mcp"`,
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
    unauthorized(req, res);
    return false;
  }
  return true;
}

function proxyToTgcli(req, res, upstreamPath) {
  if (!ensureTelegramStore()) {
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
      path: upstreamPath,
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

function getOrigin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function getBaseUrl(req) {
  return `${getOrigin(req)}${publicPrefix}`;
}

function getMcpResourceUrl(req) {
  return `${getBaseUrl(req)}/mcp`;
}

function getProtectedResourceMetadataUrl(req) {
  return `${getOrigin(req)}/.well-known/oauth-protected-resource${publicPrefix}/mcp`;
}

function oauthMetadata(req, res) {
  const base = getBaseUrl(req);
  const tokenEndpointAuthMethods = oauthClientSecret
    ? ["client_secret_post", "client_secret_basic"]
    : ["none"];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      protected_resources: [getMcpResourceUrl(req)],
      scopes_supported: ["mcp"],
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
    }),
  );
}

function oauthRegister(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    console.log(`[oauth/register] body=${body}`);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (_) {}
    const redirectUris = parsed.redirect_uris || [];
    const tokenEndpointAuthMethod = oauthClientSecret ? "client_secret_post" : "none";
    console.log(`[oauth/register] redirect_uris=${JSON.stringify(redirectUris)}`);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      client_id: oauthClientId || "telegram-private-mcp",
      client_secret: oauthClientSecret || undefined,
      client_secret_expires_at: oauthClientSecret ? 0 : undefined,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: redirectUris,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    }));
  });
}

function oauthProtectedResource(req, res) {
  const base = getBaseUrl(req);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    }),
  );
}

function oauthAuthorize(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";
  const responseType = url.searchParams.get("response_type");
  const resource = url.searchParams.get("resource");
  console.log(`[oauth/authorize] client_id=${clientId} redirect_uri=${redirectUri} response_type=${responseType} state=${state?.slice(0,16)}`);

  if (oauthClientId && clientId !== oauthClientId) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Error: invalid_client</h1>");
    return;
  }
  if (!redirectUri || responseType !== "code") {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Error: invalid_request</h1>");
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Error: invalid_request</h1>");
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const submittedPassword = params.get("password") || "";
      if (!authPassword || submittedPassword !== authPassword) {
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(loginForm(url.pathname, url.search, "Неверный пароль"));
        return;
      }
      issueCode({ codeChallenge, codeChallengeMethod, redirectUri, clientId, resource, state }, res);
    });
    return;
  }

  // GET — show login form
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(loginForm(url.pathname, url.search, ""));
}

function loginForm(actionPath, queryString, error) {
  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>Telegram MCP — вход</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f0f0f; color: #e0e0e0; }
  form { background: #1a1a1a; padding: 2rem; border-radius: 12px; width: 320px; box-shadow: 0 4px 24px #0008; }
  h2 { margin: 0 0 1.5rem; font-size: 1.2rem; }
  input[type=password] { width: 100%; padding: .6rem .8rem; border-radius: 6px; border: 1px solid #333; background: #111; color: #e0e0e0; font-size: 1rem; box-sizing: border-box; margin-bottom: 1rem; }
  button { width: 100%; padding: .7rem; border-radius: 6px; border: none; background: #2563eb; color: #fff; font-size: 1rem; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .err { color: #f87171; margin-bottom: .8rem; font-size: .9rem; }
</style></head>
<body><form method="POST" action="${escapeHtml(actionPath)}${escapeHtml(queryString)}">
  <h2>Telegram MCP</h2>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  <input type="password" name="password" placeholder="Пароль" autofocus autocomplete="current-password">
  <button type="submit">Войти</button>
</form></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function issueCode({ codeChallenge, codeChallengeMethod, redirectUri, clientId, resource, state }, res) {
  const code = randomBytes(32).toString("base64url");
  pendingCodes.set(code, {
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    clientId,
    resource,
    expiresAt: Date.now() + 300_000,
  });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

function oauthToken(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const params = new URLSearchParams(body);
    const grantType = params.get("grant_type");
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");
    const tokenClient = getTokenClientCredentials(req, params);
    const clientId = tokenClient.clientId;
    const clientSecret = tokenClient.clientSecret;
    const redirectUri = params.get("redirect_uri");
    const resource = params.get("resource");

    if (grantType !== "authorization_code") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    const pending = pendingCodes.get(code);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingCodes.delete(code);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }

    if (oauthClientId && clientId !== oauthClientId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }

    if (oauthClientSecret && clientSecret !== oauthClientSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }

    if (redirectUri && redirectUri !== pending.redirectUri) {
      pendingCodes.delete(code);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri mismatch" }));
      return;
    }

    if (pending.resource && resource && resource !== pending.resource) {
      pendingCodes.delete(code);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_target", error_description: "resource mismatch" }));
      return;
    }

    if (
      !codeVerifier ||
      pending.codeChallengeMethod !== "S256" ||
      createHash("sha256").update(codeVerifier).digest("base64url") !== pending.codeChallenge
    ) {
      pendingCodes.delete(code);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
      return;
    }

    pendingCodes.delete(code);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: bearerToken,
        token_type: "Bearer",
        expires_in: 2592000,
        scope: "mcp",
      }),
    );
  });
}

function getTokenClientCredentials(req, params) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return {
      clientId: params.get("client_id"),
      clientSecret: params.get("client_secret"),
    };
  }

  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return { clientId: null, clientSecret: null };
    }
    return {
      clientId: decodeFormComponent(decoded.slice(0, separator)),
      clientSecret: decodeFormComponent(decoded.slice(separator + 1)),
    };
  } catch (_) {
    return { clientId: null, clientSecret: null };
  }
}

function decodeFormComponent(value) {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

const server = http.createServer((req, res) => {
  console.log(`[req] ${req.method} ${req.url} | host=${req.headers.host} | x-fwd-host=${req.headers["x-forwarded-host"]} | x-fwd-proto=${req.headers["x-forwarded-proto"]}`);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  const healthPaths = new Set(["/", "/healthz"]);
  const mcpPaths = new Set(["/mcp"]);
  const wellKnownPaths = new Set(["/.well-known/oauth-authorization-server"]);
  const protectedResourcePaths = new Set([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]);
  const authorizePaths = new Set(["/oauth/authorize"]);
  const tokenPaths = new Set(["/oauth/token"]);
  const registerPaths = new Set(["/oauth/register"]);

  if (publicPrefix) {
    healthPaths.add(publicPrefix);
    healthPaths.add(`${publicPrefix}/`);
    healthPaths.add(`${publicPrefix}/healthz`);
    mcpPaths.add(`${publicPrefix}/mcp`);
    wellKnownPaths.add(`/.well-known/oauth-authorization-server${publicPrefix}`);
    wellKnownPaths.add(`${publicPrefix}/.well-known/oauth-authorization-server`);
    protectedResourcePaths.add(`/.well-known/oauth-protected-resource${publicPrefix}/mcp`);
    protectedResourcePaths.add(`${publicPrefix}/.well-known/oauth-protected-resource`);
    authorizePaths.add(`${publicPrefix}/oauth/authorize`);
    tokenPaths.add(`${publicPrefix}/oauth/token`);
    registerPaths.add(`${publicPrefix}/oauth/register`);
  }

  if (req.method === "GET" && healthPaths.has(url.pathname)) {
    health(res);
    return;
  }

  if (req.method === "GET" && wellKnownPaths.has(url.pathname)) {
    oauthMetadata(req, res);
    return;
  }

  if (req.method === "GET" && protectedResourcePaths.has(url.pathname)) {
    oauthProtectedResource(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && authorizePaths.has(url.pathname)) {
    oauthAuthorize(req, res);
    return;
  }

  if (req.method === "POST" && tokenPaths.has(url.pathname)) {
    oauthToken(req, res);
    return;
  }

  if (req.method === "POST" && registerPaths.has(url.pathname)) {
    oauthRegister(req, res);
    return;
  }

  if (!mcpPaths.has(url.pathname)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (!requireBearer(req, res)) return;
  proxyToTgcli(req, res, `/mcp${url.search}`);
});

setInterval(ensureTgcli, 5000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`[proxy] listening on 0.0.0.0:${port}`);
  console.log(`[proxy] protected MCP endpoint: /mcp`);
  console.log(`[proxy] OAuth authorization server: /.well-known/oauth-authorization-server`);
});

function shutdown() {
  if (child) child.kill("SIGTERM");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
