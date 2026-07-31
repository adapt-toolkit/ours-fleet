#!/usr/bin/env node
/**
 * Minimal credential-isolating Anthropic reverse proxy.
 *
 * Run as a dedicated service account. Configuration is environment-only:
 *   FLEET_PROXY_TOKEN_FILE=/run/secrets/anthropic-token   (root-owned 0600)
 *   FLEET_PROXY_UPSTREAM=https://api.anthropic.com
 *   FLEET_PROXY_PORT=9411
 *
 * Deploy one loopback listener per role with OS-level access controls. This
 * companion deliberately has no install/sudo lifecycle in ours-fleet.
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';

const tokenFile = process.env.FLEET_PROXY_TOKEN_FILE;
const upstream = new URL(process.env.FLEET_PROXY_UPSTREAM ?? 'https://api.anthropic.com');
const port = Number(process.env.FLEET_PROXY_PORT ?? 9411);
if (!tokenFile) throw new Error('FLEET_PROXY_TOKEN_FILE is required');
if (upstream.protocol !== 'https:') throw new Error('FLEET_PROXY_UPSTREAM must use https');
if (upstream.username || upstream.password) throw new Error('upstream URL must not contain credentials');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid FLEET_PROXY_PORT');

const secret = () => {
  const stat = statSync(tokenFile);
  if ((stat.mode & 0o077) !== 0) throw new Error('token file must not be group/world accessible');
  return readFileSync(tokenFile, 'utf8').trim();
};
const sanitizedHeaders = headers => {
  const next = { ...headers };
  for (const key of Object.keys(next))
    if (/^(authorization|proxy-authorization|x-api-key|anthropic-api-key|host)$/i.test(key))
      delete next[key];
  next.authorization = `Bearer ${secret()}`;
  next.host = upstream.host;
  return next;
};
const log = (status, started) => {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    upstreamStatus: status,
    latencyMs: Date.now() - started,
  })}\n`);
};

http.createServer((req, res) => {
  const started = Date.now();
  if (req.method === 'CONNECT') {
    res.writeHead(405).end();
    return;
  }
  if (req.url === '/healthz') {
    res.setHeader('content-type', 'application/json');
    res.end('{"schemaVersion":1,"kind":"anthropic-auth-proxy","ok":true}\n');
    return;
  }
  const target = new URL(req.url ?? '/', upstream);
  if (target.origin !== upstream.origin) {
    res.writeHead(403).end();
    return;
  }
  const outbound = https.request(target, {
    method: req.method,
    headers: sanitizedHeaders(req.headers),
  }, upstreamResponse => {
    const headers = { ...upstreamResponse.headers };
    delete headers.location; // never allow an upstream redirect to retarget credentials
    res.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(res);
    log(upstreamResponse.statusCode ?? 502, started);
  });
  outbound.on('error', error => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      errorClass: error.code ?? 'upstream-error',
      latencyMs: Date.now() - started,
    })}\n`);
  });
  req.pipe(outbound);
}).listen(port, '127.0.0.1', () => {
  process.stderr.write(`anthropic auth proxy listening on 127.0.0.1:${port}\n`);
});
