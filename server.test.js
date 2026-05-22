import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("serves RFC well-known metadata paths for a prefixed MCP resource", async (t) => {
  const app = await startServer({
    MCP_PUBLIC_PREFIX: "/telegram-private-mcp",
    MCP_BEARER_TOKEN: "test-token",
  });
  t.after(app.stop);

  const forwardedHeaders = {
    "x-forwarded-host": "api.fstr.cc",
    "x-forwarded-proto": "https",
  };

  const unauthorized = await fetch(`${app.url}/telegram-private-mcp/mcp`, {
    headers: forwardedHeaders,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(
    unauthorized.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://api.fstr.cc/telegram-private-mcp/.well-known/oauth-protected-resource", scope="mcp"',
  );

  const resourceMetadata = await getJson(
    `${app.url}/.well-known/oauth-protected-resource/telegram-private-mcp/mcp`,
    { headers: forwardedHeaders },
  );
  assert.equal(resourceMetadata.status, 200);
  assert.deepEqual(resourceMetadata.body, {
    resource: "https://api.fstr.cc/telegram-private-mcp/mcp",
    authorization_servers: ["https://api.fstr.cc/telegram-private-mcp"],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  });

  const routedResourceMetadata = await getJson(
    `${app.url}/telegram-private-mcp/.well-known/oauth-protected-resource`,
    { headers: forwardedHeaders },
  );
  assert.equal(routedResourceMetadata.status, 200);
  assert.deepEqual(routedResourceMetadata.body, resourceMetadata.body);

  const authMetadata = await getJson(
    `${app.url}/.well-known/oauth-authorization-server/telegram-private-mcp`,
    { headers: forwardedHeaders },
  );
  assert.equal(authMetadata.status, 200);
  assert.equal(authMetadata.body.issuer, "https://api.fstr.cc/telegram-private-mcp");
  assert.equal(authMetadata.body.authorization_endpoint, "https://api.fstr.cc/telegram-private-mcp/oauth/authorize");
  assert.equal(authMetadata.body.token_endpoint, "https://api.fstr.cc/telegram-private-mcp/oauth/token");
  assert.deepEqual(authMetadata.body.protected_resources, ["https://api.fstr.cc/telegram-private-mcp/mcp"]);

  const authorizeUrl = new URL(`${app.url}/telegram-private-mcp/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: "telegram-private-mcp",
    redirect_uri: "http://127.0.0.1/callback",
    response_type: "code",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  }).toString();

  const login = await fetch(authorizeUrl, { headers: forwardedHeaders });
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.match(loginHtml, /action="\/telegram-private-mcp\/oauth\/authorize\?/);
});

test("registered clients are told to send client_secret when the token endpoint requires it", async (t) => {
  const app = await startServer({
    MCP_PUBLIC_PREFIX: "/telegram-private-mcp",
    MCP_AUTH_PASSWORD: "pw",
    MCP_BEARER_TOKEN: "issued-token",
    OAUTH_CLIENT_SECRET: "registered-secret",
  });
  t.after(app.stop);

  const forwardedHeaders = {
    "x-forwarded-host": "api.fstr.cc",
    "x-forwarded-proto": "https",
  };
  const redirectUri = "http://127.0.0.1/callback";
  const resource = "https://api.fstr.cc/telegram-private-mcp/mcp";
  const verifier = "test-code-verifier-1234567890";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const registration = await getJson(`${app.url}/telegram-private-mcp/oauth/register`, {
    method: "POST",
    headers: {
      ...forwardedHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.body.client_secret, "registered-secret");
  assert.equal(registration.body.client_secret_expires_at, 0);
  assert.equal(registration.body.token_endpoint_auth_method, "client_secret_post");

  const authorizeUrl = new URL(`${app.url}/telegram-private-mcp/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: registration.body.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();

  const authorization = await fetch(authorizeUrl, {
    method: "POST",
    headers: {
      ...forwardedHeaders,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ password: "pw" }),
    redirect: "manual",
  });
  assert.equal(authorization.status, 302);
  const code = new URL(authorization.headers.get("location")).searchParams.get("code");
  assert.ok(code);

  const tokenWithoutSecret = await fetch(`${app.url}/telegram-private-mcp/oauth/token`, {
    method: "POST",
    headers: {
      ...forwardedHeaders,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(tokenWithoutSecret.status, 401);

  const token = await getJson(`${app.url}/telegram-private-mcp/oauth/token`, {
    method: "POST",
    headers: {
      ...forwardedHeaders,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      client_secret: "registered-secret",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(token.status, 200);
  assert.equal(token.body.access_token, "issued-token");
  assert.equal(token.body.token_type, "Bearer");
  assert.equal(token.body.scope, "mcp");
});

test("supports Coolify path routing when the public MCP endpoint is the prefix", async (t) => {
  const app = await startServer({
    MCP_PUBLIC_PREFIX: "/mcp",
    MCP_BEARER_TOKEN: "test-token",
  });
  t.after(app.stop);

  const forwardedHeaders = {
    "x-forwarded-host": "fstr.cc",
    "x-forwarded-proto": "https",
  };

  const unauthorized = await fetch(`${app.url}/`, {
    method: "POST",
    headers: forwardedHeaders,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(
    unauthorized.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://fstr.cc/mcp/.well-known/oauth-protected-resource", scope="mcp"',
  );

  const resourceMetadata = await getJson(`${app.url}/.well-known/oauth-protected-resource`, {
    headers: forwardedHeaders,
  });
  assert.equal(resourceMetadata.status, 200);
  assert.equal(resourceMetadata.body.resource, "https://fstr.cc/mcp");
  assert.deepEqual(resourceMetadata.body.authorization_servers, ["https://fstr.cc/mcp"]);

  const authMetadata = await getJson(`${app.url}/.well-known/oauth-authorization-server`, {
    headers: forwardedHeaders,
  });
  assert.equal(authMetadata.status, 200);
  assert.equal(authMetadata.body.issuer, "https://fstr.cc/mcp");
  assert.equal(authMetadata.body.authorization_endpoint, "https://fstr.cc/mcp/oauth/authorize");
  assert.deepEqual(authMetadata.body.protected_resources, ["https://fstr.cc/mcp"]);

  const openIdMetadata = await getJson(`${app.url}/.well-known/openid-configuration`, {
    headers: forwardedHeaders,
  });
  assert.equal(openIdMetadata.status, 200);
  assert.equal(openIdMetadata.body.issuer, "https://fstr.cc/mcp");
  assert.equal(openIdMetadata.body.token_endpoint, "https://fstr.cc/mcp/oauth/token");

  const authorizeUrl = new URL(`${app.url}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: "telegram-private-mcp",
    redirect_uri: "http://127.0.0.1/callback",
    response_type: "code",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  }).toString();

  const login = await fetch(authorizeUrl, { headers: forwardedHeaders });
  assert.equal(login.status, 200);
  assert.match(await login.text(), /action="\/mcp\/oauth\/authorize\?/);
});

async function getJson(url, init) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

async function startServer(env = {}) {
  const port = await getFreePort();
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "telegram-private-mcp-test-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      TGCLI_STORE: storeDir,
      MCP_PUBLIC_PREFIX: "",
      MCP_BEARER_TOKEN: "test-token",
      MCP_AUTH_PASSWORD: "",
      OAUTH_CLIENT_ID: "",
      OAUTH_CLIENT_SECRET: "",
      TELEGRAM_API_ID: "",
      TELEGRAM_API_HASH: "",
      TELEGRAM_SESSION_STRING: "",
      TG_API_ID: "",
      TG_API_HASH: "",
      TG_SESSION_STRING: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      const response = await fetch(`${url}/healthz`);
      return response.ok;
    }, () => output);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    url,
    stop: () => stopServer(child),
  };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(condition, getDebugOutput) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready\n${lastError?.message || ""}\n${getDebugOutput()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
