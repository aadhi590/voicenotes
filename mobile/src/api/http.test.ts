// Regression: in SDK 58 the global fetch is expo/fetch, which rejects React Native's
// {uri, name, type} FormData objects — uploads failed on the phone before reaching the server.
// uploadDoc must use expo-file-system's native multipart uploader with the ORIGINAL filename.

jest.mock("../config", () => ({ API_URL: "https://api.test", CONFIG_ERROR: null }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "tmp-uuid" }));

const mockUpload = jest.fn();
const mockCopy = jest.fn();
const mockDelete = jest.fn();
const mockCreate = jest.fn();

jest.mock("expo-file-system", () => {
  const join = (parts: unknown[]): string =>
    parts.map((p) => (typeof p === "string" ? p : (p as { uri: string }).uri)).join("/");
  class Directory {
    uri: string;
    exists = true;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    create(opts: unknown) {
      mockCreate(this.uri, opts);
    }
    delete() {
      mockDelete(this.uri);
    }
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    copy(dest: File) {
      return mockCopy(this.uri, dest.uri);
    }
    upload(url: string, options: unknown) {
      return mockUpload(this.uri, url, options);
    }
  }
  return { Directory, File, Paths: { cache: { uri: "file:///cache" } }, UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 } };
});

import { ApiError, uploadDoc } from "./http";

const picked = { uri: "file:///cache/DocumentPicker/8f2c1a.pdf", name: "notes_os.pdf", mimeType: "application/pdf" };
const STAGED = "file:///cache/uploads/tmp-uuid/notes_os.pdf";

beforeEach(() => {
  jest.clearAllMocks();
  mockCopy.mockResolvedValue(undefined);
  globalThis.fetch = jest.fn(() => Promise.reject(new Error("fetch must not be used for uploads"))) as unknown as typeof fetch;
});

test("uploads via native multipart with the original filename and device header, never fetch", async () => {
  mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify({ doc_name: "notes_os.pdf", pages: 3, chunks: 3 }), headers: {} });

  await expect(uploadDoc("dev-1", picked)).resolves.toEqual({ doc_name: "notes_os.pdf", pages: 3, chunks: 3 });

  expect(mockCopy).toHaveBeenCalledWith(picked.uri, STAGED);
  const [stagedUri, url, options] = mockUpload.mock.calls[0];
  expect(stagedUri).toBe(STAGED); // multipart filename = original name, not the picker's cache name
  expect(url).toBe("https://api.test/docs");
  expect(options).toMatchObject({
    httpMethod: "POST",
    uploadType: 1, // MULTIPART
    fieldName: "file",
    mimeType: "application/pdf",
    headers: { "X-Device-Id": "dev-1" },
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledWith("file:///cache/uploads/tmp-uuid"); // temp copy cleaned up
});

test("backend 4xx detail is surfaced verbatim (scanned PDF)", async () => {
  mockUpload.mockResolvedValue({
    status: 422,
    body: JSON.stringify({ detail: "No text found. Scanned PDFs are not supported." }),
    headers: {},
  });
  const err = await uploadDoc("dev-1", picked).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 422, message: "No text found. Scanned PDFs are not supported." });
  expect(mockDelete).toHaveBeenCalled();
});

test("network failure and unreadable file give clear messages", async () => {
  mockUpload.mockRejectedValue(new Error("socket hang up"));
  await expect(uploadDoc("dev-1", picked)).rejects.toMatchObject({ message: "Can't reach server. Check your connection." });

  mockCopy.mockRejectedValue(new Error("permission denied"));
  await expect(uploadDoc("dev-1", picked)).rejects.toMatchObject({
    message: "Couldn't read the selected file. Try picking it again.",
  });
});

test("path separators in the picked name can't escape the staging folder", async () => {
  mockUpload.mockResolvedValue({ status: 200, body: "{}", headers: {} });
  await uploadDoc("dev-1", { ...picked, name: "../../evil/notes.pdf" });
  expect(mockCopy).toHaveBeenCalledWith(picked.uri, "file:///cache/uploads/tmp-uuid/.._.._evil_notes.pdf");
});
