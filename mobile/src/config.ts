/**
 * Runtime config. EXPO_PUBLIC_* vars are inlined at bundle time and MUST be referenced
 * statically as `process.env.EXPO_PUBLIC_X` (no destructuring / bracket access).
 */

export function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(trimmed) ? trimmed : null;
}

/** https://host -> wss://host/ask, http://host -> ws://host/ask */
export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/i, "ws") + "/ask";
}

export const API_URL: string | null = normalizeBaseUrl(process.env.EXPO_PUBLIC_API_URL);
export const WS_URL: string | null = API_URL ? toWsUrl(API_URL) : null;
export const CONFIG_ERROR: string | null = API_URL
  ? null
  : "EXPO_PUBLIC_API_URL is missing or invalid. Set it in mobile/.env (see .env.example) and restart Expo.";

export const MAX_QUESTION_CHARS = 1000;
