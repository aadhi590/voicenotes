// Regression: in SDK 58 the global fetch is expo/fetch, which rejects React Native's
// {uri, name, type} FormData objects — uploads failed on the phone before reaching the server.
// uploadDoc must use expo-file-system's native multipart uploader with the ORIGINAL filename,
// and must not fail just because staging (copy) fails on a device.

jest.mock("../config", () => ({ API_URL: "https://api.test", CONFIG_ERROR: null }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "tmp-uuid" }));

const mockUpload = jest.fn();
const mockCopy = jest.fn();
const mockWrite = jest.fn();
const mockBytes = jest.fn();
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
    get name() {
      return this.uri.split("/").pop();
    }
    copy(dest: File) {
      return mockCopy(this.uri, dest.uri);
    }
    bytes() {
      return mockBytes(this.uri);
    }
    write(content: unknown) {
      return mockWrite(this.uri, content);
    }
    upload(url: string, options: unknown) {
      return mockUpload(this.uri, url, options);
    }
  }
  return { Directory, File, Paths: { cache: { uri: "file:///cache" } }, UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 } };
});

import { File } from "expo-file-system";

import { ApiError, uploadDoc, uploadName } from "./http";

const PICKED_URI = "content://com.android.providers.downloads/document/42";
// The File instance from File.pickFileAsync carries the granted READ permission.
const pickedFile = (uri: string = PICKED_URI): File => new File(uri);
const pick = (overrides: Partial<{ file: File; name: string; mimeType: string }> = {}) => ({
  file: pickedFile(),
  name: "notes_os.pdf",
  mimeType: "application/pdf",
  ...overrides,
});
const STAGED = "file:///cache/uploads/tmp-uuid/notes_os.pdf";
const OK = { status: 200, body: JSON.stringify({ doc_name: "notes_os.pdf", pages: 3, chunks: 3 }), headers: {} };
const uploadedUri = (): string => mockUpload.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  mockCopy.mockResolvedValue(undefined);
  mockBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mockWrite.mockResolvedValue(undefined);
  mockUpload.mockResolvedValue(OK);
  globalThis.fetch = jest.fn(() => Promise.reject(new Error("fetch must not be used for uploads"))) as unknown as typeof fetch;
});

test("native multipart upload with the original filename + device header, never fetch", async () => {
  await expect(uploadDoc("dev-1", pick())).resolves.toEqual({ doc_name: "notes_os.pdf", pages: 3, chunks: 3 });

  expect(mockCopy).toHaveBeenCalledWith(PICKED_URI, STAGED);
  expect(uploadedUri()).toBe(STAGED); // multipart filename = original name, not the cache name
  const [, url, options] = mockUpload.mock.calls[0];
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

test("picked file already has the right name -> uploaded directly, no copy", async () => {
  await uploadDoc("dev-1", pick({ file: pickedFile("file:///cache/DocumentPicker/notes_os.pdf") }));
  expect(mockCopy).not.toHaveBeenCalled();
  expect(uploadedUri()).toBe("file:///cache/DocumentPicker/notes_os.pdf");
});

test("copy fails on the device -> read+write fallback still uploads under the original name", async () => {
  mockCopy.mockRejectedValue(new Error("copy not supported"));
  await expect(uploadDoc("dev-1", pick())).resolves.toMatchObject({ pages: 3 });
  expect(mockWrite).toHaveBeenCalledWith(STAGED, new Uint8Array([1, 2, 3]));
  expect(uploadedUri()).toBe(STAGED);
});

test("all staging fails -> uploads the picked file as-is instead of blocking the user", async () => {
  mockCopy.mockRejectedValue(new Error("nope"));
  mockWrite.mockRejectedValue(new Error("nope"));
  await expect(uploadDoc("dev-1", pick())).resolves.toMatchObject({ pages: 3 });
  expect(uploadedUri()).toBe(PICKED_URI);
});

test("backend 4xx detail is surfaced verbatim (scanned PDF)", async () => {
  mockUpload.mockResolvedValue({ status: 422, body: JSON.stringify({ detail: "No text found. Scanned PDFs are not supported." }), headers: {} });
  const err = await uploadDoc("dev-1", pick()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 422, message: "No text found. Scanned PDFs are not supported." });
  expect(mockDelete).toHaveBeenCalled();
});

test("network failure vs unreadable file give different, clear messages", async () => {
  mockUpload.mockRejectedValue(new Error("socket hang up"));
  await expect(uploadDoc("dev-1", pick())).rejects.toMatchObject({ message: "Can't reach server. Check your connection." });

  mockUpload.mockRejectedValue(new Error("File does not exist or cannot be read"));
  await expect(uploadDoc("dev-1", pick())).rejects.toMatchObject({
    message: "Couldn't read the selected file. Try picking it again.",
  });
});

test("path separators in the picked name can't escape the staging folder", async () => {
  await uploadDoc("dev-1", pick({ name: "../../evil/notes.pdf" }));
  expect(mockCopy).toHaveBeenCalledWith(PICKED_URI, "file:///cache/uploads/tmp-uuid/.._.._evil_notes.pdf");
});

test("uses the picked File instance itself (it holds the READ permission), never a new File(uri)", async () => {
  const file = pickedFile();
  const own = jest.fn().mockResolvedValue(undefined);
  (file as unknown as { copy: typeof own }).copy = own;
  await uploadDoc("dev-1", pick({ file }));
  expect(own).toHaveBeenCalledTimes(1);
  expect(mockCopy).not.toHaveBeenCalled();
});

test("uploadName keeps supported extensions and adds one from the MIME type", () => {
  expect(uploadName("notes_os.pdf", "application/pdf")).toBe("notes_os.pdf");
  expect(uploadName("Lecture 3.MD", "application/octet-stream")).toBe("Lecture 3.MD");
  expect(uploadName("document_42", "application/pdf")).toBe("document_42.pdf");
  expect(uploadName("readme", "text/markdown")).toBe("readme.md");
  expect(uploadName("log", "text/csv")).toBe("log.txt");
  expect(uploadName("photo", "image/png")).toBe("photo"); // backend returns its clear 400
  expect(uploadName("  ", undefined)).toBe("notes");
});
