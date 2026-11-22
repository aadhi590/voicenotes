import { API_URL, CONFIG_ERROR } from "../config";

export interface Health {
  status: string;
  groq_configured: boolean;
}
export interface DocInfo {
  doc_name: string;
  chunks: number;
}
export interface DocList {
  docs: DocInfo[];
  total_chunks: number;
}
export interface UploadResult {
  doc_name: string;
  pages: number;
  chunks: number;
}
export interface PickedFile {
  uri: string;
  name: string;
  mimeType?: string;
}

/** An HTTP failure with a message that is safe to show the user verbatim. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 90_000; // big PDFs on mobile data

function detailOf(body: unknown, status: number): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return `Request failed (HTTP ${status})`;
}

async function request<T>(
  path: string,
  deviceId: string | null,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (!API_URL) throw new ApiError(0, CONFIG_ERROR ?? "API URL not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (deviceId) headers["X-Device-Id"] = deviceId;
  let response: Response;
  try {
    response = await fetch(API_URL + path, { ...init, headers, signal: controller.signal });
  } catch {
    throw new ApiError(0, controller.signal.aborted ? "Server took too long to respond." : "Can't reach server. Check your connection.");
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new ApiError(response.status, detailOf(body, response.status));
  return body as T;
}

export function health(): Promise<Health> {
  return request<Health>("/health", null);
}

export function listDocs(deviceId: string): Promise<DocList> {
  return request<DocList>("/docs", deviceId);
}

export function uploadDoc(deviceId: string, file: PickedFile): Promise<UploadResult> {
  const form = new FormData();
  // React Native's FormData accepts {uri, name, type} for files; the DOM typing doesn't know that.
  form.append("file", { uri: file.uri, name: file.name, type: file.mimeType ?? "application/octet-stream" } as unknown as Blob);
  // No Content-Type header: fetch sets multipart/form-data with the boundary itself.
  return request<UploadResult>("/docs", deviceId, { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
}

export function deleteDoc(deviceId: string, docName: string): Promise<{ deleted: string }> {
  return request("/docs/" + encodeURIComponent(docName), deviceId, { method: "DELETE" });
}

export function clearDocs(deviceId: string): Promise<{ cleared: boolean }> {
  return request("/docs", deviceId, { method: "DELETE" });
}
