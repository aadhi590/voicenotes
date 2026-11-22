import { defineRailway, github, project, service } from "railway/iac";

// Railway infrastructure for the VoiceNotes backend (replaces backend/railway.json,
// whose Config-as-Code format Railway stops reading on 2026-12-01).
// Preview: `railway config plan`   Apply: `railway config apply`   (run from the repo root)
export default defineRailway(() => {
  const api = service("api", {
    // Deploy from GitHub on every push to main. "Wait for CI" (checkSuites) does not persist via the
    // API on this project (verified 2026-11-22), so it is toggled in the dashboard instead:
    // service api -> Settings -> Source -> Wait for CI.
    source: github("aadhi590/voicenotes", { branch: "main", rootDirectory: "/backend" }),
    build: {
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/backend/**"], // the mobile app will live in /mobile; don't redeploy for it
    },
    deploy: {
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
      sleepApplication: false, // notes are in memory: sleeping would wipe them
    },
    replicas: { iad: 1 }, // exactly one replica: the in-memory store is not shared
  });

  return project("voicenotes", {
    variables: { managed: false }, // GROQ_API_KEY is set by hand / CLI, never stored in code
    resources: [api],
  });
});
