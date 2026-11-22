# VoiceNotes backend — deployment

| | |
|---|---|
| **Production URL** | https://api-production-90b19b2d.up.railway.app |
| WebSocket | `wss://api-production-90b19b2d.up.railway.app/ask?device_id=<id>` |
| Health | https://api-production-90b19b2d.up.railway.app/health → `{"status":"ok","groq_configured":true}` |
| API docs (Swagger) | https://api-production-90b19b2d.up.railway.app/swagger |
| Railway project / service | `voicenotes` / `api` (environment `production`) |
| GitHub | https://github.com/aadhi590/voicenotes (deploy root: `backend/`) |

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | yes | Set in Railway → service `api` → Variables. Never commit it. Without it the server still starts, `/health` reports `groq_configured: false`, and `/stt` + `/ask` return a clear error. |
| `PORT` | auto | Injected by Railway; the start command binds to it. Locally the server runs on 8000. |

Rotate the key: create a new one at console.groq.com, then
`cd backend && echo "<new key>" | railway variable set GROQ_API_KEY --stdin --service api` (this redeploys).

## How to redeploy

The service was created with `railway up` (uploads the local `backend/` folder). It is **not** linked to GitHub yet, so `git push` does **not** redeploy.

```bash
cd app1/backend
railway up --detach --service api      # upload + build + deploy (~40 s)
railway logs --service api             # expect: "startup llm=... stt=... groq_key_set=True"
```

To auto-deploy on every push instead (one-time, in the dashboard): service `api` → Settings → Source → connect `aadhi590/voicenotes`, branch `main`, **Root Directory `/backend`**.

What gets uploaded is controlled by `backend/.railwayignore` (excludes `.env`, `.venv`, tests, scripts).
Build/runtime config lives in `backend/railway.json` (start command, `/health` healthcheck, restart on failure); `Procfile` has the same start command as a fallback.

## Verify a deployment

```bash
cd app1/backend
curl https://api-production-90b19b2d.up.railway.app/health
.venv/Scripts/python scripts/e2e/run_all.py --base https://api-production-90b19b2d.up.railway.app --quick   # ~10 s, 2 LLM calls
.venv/Scripts/python scripts/e2e/run_all.py --base https://api-production-90b19b2d.up.railway.app           # full, ~10 min (rate limit)
```

Last verified 2026-11-22: `--quick` 9/9 over `wss://` (TTFT 171–360 ms, network RTT ~300 ms, cancel confirmed in ~1 RTT).

## Known limits

- **In-memory storage.** Uploaded notes live in process memory: they are lost on every redeploy/restart, and the service must stay at **1 replica** (replicas would not share notes). After a redeploy users get "You haven't uploaded any notes yet" and must re-upload.
- **Groq free-tier rate limit: 8,000 tokens/minute** on the current key. One answer costs ~1,400 tokens (≈1,170 prompt with `TOP_K=3` + 250 max output), so about **5–6 answers per minute** across all users. Beyond that `/ask` immediately sends `{"type":"error","message":"The AI service is busy (rate limit reached)..."}` (no silent retries); the client should show it and retry after a few seconds. A paid Groq tier removes this.
- **No auth.** Anyone with the URL can upload notes and spend the Groq quota. `X-Device-Id` only separates data; it is not a secret. Fine for an MVP demo; add auth before sharing widely.
- **Barge-in over a real network.** Generation is faster than speech: a short answer can finish streaming before a cancel arrives (~1 RTT). The server then ignores the cancel (correct per protocol), so the mobile app must also stop its local TTS playback on barge-in.
- **Railway Config-as-Code deprecation.** Railway warns that `railway.json` keeps working only until **2026-12-01**. After that the healthcheck/restart policy in it may be ignored (the start command still comes from `Procfile`). Migrate with `railway config migrate --service api --variables unmanaged --apply`, then `railway config migrate cutover` (reversible with `railway config migrate undo`).
- Uploads ≤ 15 MB (PDF/TXT/MD, text-based PDFs only); audio ≤ 20 MB.
