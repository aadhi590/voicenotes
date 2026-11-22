import * as Crypto from "expo-crypto";
import { Directory, File, Paths, UploadType } from "expo-file-system";

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Multipart upload via expo-file-system's native uploader.
 *
 * Why not fetch + FormData: in SDK 58 the global fetch on Android/iOS is expo/fetch (WinterCG),
 * which does not accept React Native's `{uri, name, type}` FormData file objects; the request
 * failed on the device before reaching the server.
 *
 * The file is first copied to a temp folder under its ORIGINAL name, because the multipart
 * filename is the on-disk name and the backend uses it as the doc name + type (.pdf/.txt/.md);
 * the picker's cache copy can have a generated name.
 */
export async function uploadDoc(deviceId: string, file: PickedFile): Promise<UploadResult> {
  if (!API_URL) throw new ApiError(0, CONFIG_ERROR ?? "API URL not configured");
  const safeName = file.name.replace(/[\\/]/g, "_").trim() || "notes";
  const stagingDir = new Directory(Paths.cache, "uploads", Crypto.randomUUID());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    let staged: File;
    try {
      stagingDir.create({ intermediates: true });
      staged = new File(stagingDir, safeName);
      await new File(file.uri).copy(staged);
    } catch {
      throw new ApiError(0, "Couldn't read the selected file. Try picking it again.");
    }

    let result: { status: number; body: string };
    try {
      result = await staged.upload(API_URL + "/docs", {
        httpMethod: "POST",
        uploadType: UploadType.MULTIPART,
        fieldName: "file",
        mimeType: file.mimeType ?? "application/octet-stream",
        headers: { "X-Device-Id": deviceId, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(0, controller.signal.aborted ? "Upload took too long. Try a smaller file." : "Can't reach server. Check your connection.");
    }

    const body = parseJson(result.body); // non-2xx responses resolve too: surface "detail" verbatim
    if (result.status < 200 || result.status >= 300) throw new ApiError(result.status, detailOf(body, result.status));
    return body as UploadResult;
  } finally {
    clearTimeout(timer);
    try {
      if (stagingDir.exists) stagingDir.delete();
    } catch {
      /* temp cache; the OS cleans it eventually */
    }
  }
}

export function deleteDoc(deviceId: string, docName: string): Promise<{ deleted: string }> {
  return request("/docs/" + encodeURIComponent(docName), deviceId, { method: "DELETE" });
}

export function clearDocs(deviceId: string): Promise<{ cleared: boolean }> {
  return request("/docs", deviceId, { method: "DELETE" });
}
