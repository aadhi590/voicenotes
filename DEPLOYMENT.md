# VoiceNotes backend — deployment

| | |
|---|---|
| **Production URL** | https://api-production-90b19b2d.up.railway.app |
| WebSocket | `wss://api-production-90b19b2d.up.railway.app/ask?device_id=<id>` |
| Health | https://api-production-90b19b2d.up.railway.app/health → `{"status":"ok","groq_configured":true}` |
| API docs (Swagger) | https://api-production-90b19b2d.up.railway.app/swagger |
| Railway | project `voicenotes`, service `api`, environment `production`, region `iad` (US East), 1 replica |
| GitHub | https://github.com/aadhi590/voicenotes — Railway deploys `backend/` from `main` |
| CI | GitHub Actions `backend-tests` (pytest on Python 3.11, Groq mocked) on every push / PR |

## How deploys work

```
git push origin main
   ├─ GitHub Actions: pytest (backend-tests)
   └─ Railway: build backend/ (Railpack, Python 3.11 from .python-version) → healthcheck /health → switch traffic
```

- Only changes under `backend/` trigger a Railway deploy (watch pattern), so the future `mobile/` app won't redeploy the API.
- A failed healthcheck keeps the previous deployment serving. Crashes restart up to 3 times.
- Optional, one click: service `api` → Settings → Source → **Wait for CI**, so a red test run blocks the deploy. This setting can't be set from code on this project.
- Expect in the deploy logs: `startup llm=qwen/qwen3.8-27b stt=whisper-large-v3-turbo groq_key_set=True python=3.11.x`

Manual deploy of local, uncommitted code (bypasses GitHub): `cd backend && railway up --detach --service api`
(`backend/.railwayignore` keeps `.env`, `.venv`, tests and scripts out of the upload.)

## Infrastructure as code

Railway settings live in `.railway/railway.ts` (repo root): GitHub source + root `/backend`, start command,
`/health` healthcheck (60 s), restart on failure ×3, no sleeping, 1 replica. `railway.json` was removed: Railway
stops reading Config-as-Code files on 2026-12-01, and `railway config migrate status` confirms nothing reads it.

```powershell
# from the repo root, in PowerShell (see the Windows note)
$env:_ = "$env:APPDATA\npm\node_modules\@railway\cli\bin\railway.exe"
railway config plan            # should say: already up to date
railway config apply --yes     # after editing .railway/railway.ts
```

Windows note: the Railway SDK checks the CLI version by launching `railway` without a shell, which fails on Windows npm
shims. Setting `$env:_` to the real `railway.exe` works around it. Git Bash overwrites `_`, so use PowerShell.
`package.json` at the repo root only holds this SDK, and lives outside `backend/` so Railpack still detects Python.

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | yes | Railway → service `api` → Variables. Not managed by IaC (`variables: unmanaged`), never in git. Without it the server starts, `/health` reports `groq_configured: false`, and `/stt` + `/ask` return a clear error. |
| `PORT` | auto | Injected by Railway; the start command binds to it. Locally: 8000. |

Rotate the key: create a new one at console.groq.com, then (this redeploys):
```bash
cd app1/backend && echo "<new key>" | railway variable set GROQ_API_KEY --stdin --service api
```

## Verify a deployment

```bash
cd app1/backend
curl https://api-production-90b19b2d.up.railway.app/health
.venv/Scripts/python scripts/e2e/run_all.py --base https://api-production-90b19b2d.up.railway.app --quick   # ~10 s, 2 LLM calls
.venv/Scripts/python scripts/e2e/run_all.py --base https://api-production-90b19b2d.up.railway.app           # full, ~10 min (rate limit)
```

Last verified 2026-11-22 on the GitHub-deployed build: `--quick` 9/9 over `wss://` (TTFT 230 ms, RTT ~285 ms,
cancel confirmed in ~1 RTT), Python 3.11.17, CI green.

## Pushing from this machine

This repo uses repo-local git credentials (`gh auth git-credential` as `aadhi590`), so other repos keep using your
`aadhityah` login. If a push returns 403, run `gh auth switch -u aadhi590` or `gh auth status` to check. Pushing workflow files
needs the `workflow` scope (already granted).

## Known limits

- **In-memory storage.** Notes live in process memory: lost on every redeploy/restart, and the service must stay at
  **1 replica**. After a redeploy users get "You haven't uploaded any notes yet" and must re-upload.
- **Memory guards (public URL).** Per device: max **20 docs** (409) and **1,000 chunks** ≈ 800 pages (413).
  Globally: **50,000 chunks** (~450 MB). Above that the least-recently-used devices are evicted, and the log says
  `memory budget: evicted N idle device(s)`. Tune in `backend/config.py`.
- **Groq free-tier rate limit: 8,000 tokens/minute.** About 1,400 tokens per answer, so about **5–6 answers per minute** across
  all users. Beyond that `/ask` immediately sends `{"type":"error","message":"The AI service is busy (rate limit
  reached)..."}`. The client should show it and retry. A paid Groq tier removes this.
- **No auth.** Anyone with the URL can use the API and the Groq quota. `X-Device-Id` separates data but is not a
  secret. Add auth before sharing widely.
- **Barge-in over a real network.** Answers often finish streaming (a few hundred ms) before a cancel arrives
  (~1 RTT ≈ 285 ms from India to `iad`). The server then ignores the cancel (correct per protocol), so the
  mobile app must stop its own TTS playback locally on barge-in.
- **Long-lived WebSockets** can be dropped by proxies or network changes. The mobile client should reconnect and resend
  the question on close.
- Uploads ≤ 15 MB (PDF/TXT/MD, text-based PDFs only); audio ≤ 20 MB.
