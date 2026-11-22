#!/usr/bin/env node
// Smoke test of the exact URL wiring the app uses, against the REAL backend.
// Reads EXPO_PUBLIC_API_URL from mobile/.env, derives the WS URL like src/config.ts,
// checks /health, then asks one question over the WebSocket and prints every event.
// Uploads nothing: a fresh device id has no notes, so the expected answer is the
// "upload first" message. Needs Node 22+ (global WebSocket).
//
//   node scripts/smoke_ws.mjs ["question"]

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 30_000;
const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

function readApiUrl() {
  let raw = process.env.EXPO_PUBLIC_API_URL;
  if (!raw) {
    try {
      const line = readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("EXPO_PUBLIC_API_URL="));
      raw = line?.slice("EXPO_PUBLIC_API_URL=".length);
    } catch {
      /* no .env */
    }
  }
  // same rules as normalizeBaseUrl() / toWsUrl() in src/config.ts
  const base = (raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new Error(`EXPO_PUBLIC_API_URL missing/invalid in ${envPath}`);
  return { base, ws: base.replace(/^http/i, "ws") + "/ask" };
}

if (typeof WebSocket === "undefined") {
  console.error("This script needs Node 22+ (global WebSocket). Current:", process.version);
  process.exit(2);
}

const question = process.argv[2] ?? "What is the default time quantum in round robin?";
const { base, ws: wsBase } = readApiUrl();
const deviceId = `smoke-${randomUUID()}`;

console.log(`API  ${base}`);
const health = await (await fetch(`${base}/health`)).json();
console.log(`GET /health -> ${JSON.stringify(health)}`);

const url = `${wsBase}?device_id=${encodeURIComponent(deviceId)}`;
console.log(`WS   ${url}`);

const id = randomUUID();
const started = performance.now();
const ms = () => `${Math.round(performance.now() - started)}ms`.padStart(7);
const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.error("FAIL: timed out waiting for done");
  process.exit(1);
}, TIMEOUT_MS);

ws.onopen = () => {
  console.log(`${ms()}  open -> ask ${JSON.stringify(question)}`);
  ws.send(JSON.stringify({ type: "ask", id, question }));
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  console.log(`${ms()}  ${msg.type.padEnd(9)} ${JSON.stringify(msg)}`);
  if (msg.id === id && (msg.type === "done" || msg.type === "error" || msg.type === "cancelled")) {
    clearTimeout(timer);
    ws.close();
    const ok = msg.type === "done";
    console.log(ok ? "PASS: URL/env wiring works end to end" : "FAIL: terminal event was not 'done'");
    process.exit(ok ? 0 : 1);
  }
};
ws.onerror = (err) => {
  console.error("FAIL: websocket error", err?.message ?? err);
  process.exit(1);
};
