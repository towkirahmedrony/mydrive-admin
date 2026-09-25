/**
 * Drive migration — destination verification + byte-relay unit tests.
 *
 * Covers the copy path's correctness guarantees without touching Google:
 * `fetchImpl` is injected into the verification primitive, and the resumable
 * uploader is driven through a stubbed global `fetch`.
 *
 * Run:
 *   node --experimental-strip-types --test tests/drive-migration-verify.test.ts
 *
 * Scenarios covered here: successful relay, resumable upload request shape,
 * destination verification, MD5 equality, size equality, wrong folder / wrong
 * MD5 / wrong size / trashed rejection, source read failure, upload failure,
 * verification failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DriveVerifyError,
  fetchDriveFileMetadata,
  verifyDriveUpload,
} from "../supabase/functions/_shared/drive-verify.ts";
import { uploadStreaming } from "../supabase/functions/_shared/google-drive-upload.ts";

// ── helpers ────────────────────────────────────────────────────────────────

const SRC_MD5 = "f147b62602b8ea8e0d0f6f3a4b1c2d3e";
const SRC_SIZE = 13109572;

/** Minimal Response stand-in for the metadata read. */
function metaResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function driveFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "DEST_FILE_ID",
    name: "video_20260815_181205_media_c85709f3.mp4",
    mimeType: "video/mp4",
    size: String(SRC_SIZE),
    parents: ["DEST_FOLDER_ID"],
    trashed: false,
    md5Checksum: SRC_MD5,
    ...overrides,
  };
}

const BASE_PARAMS = {
  accessToken: "dest-token",
  fileId: "DEST_FILE_ID",
  expectedName: "video_20260815_181205_media_c85709f3.mp4",
  expectedParentId: "DEST_FOLDER_ID",
  expectedSize: SRC_SIZE,
  expectedMd5: SRC_MD5,
};

// ── metadata read ──────────────────────────────────────────────────────────

test("fetchDriveFileMetadata reads a file resource", async () => {
  const meta = await fetchDriveFileMetadata({
    accessToken: "t",
    fileId: "DEST_FILE_ID",
    fetchImpl: (async () => metaResponse(driveFile())) as unknown as typeof fetch,
  });
  assert.equal(meta.id, "DEST_FILE_ID");
  assert.equal(meta.size, String(SRC_SIZE));
  assert.equal(meta.md5Checksum, SRC_MD5);
  assert.deepEqual(meta.parents, ["DEST_FOLDER_ID"]);
  assert.equal(meta.trashed, false);
});

test("fetchDriveFileMetadata treats explicitlyTrashed as trashed", async () => {
  const meta = await fetchDriveFileMetadata({
    accessToken: "t",
    fileId: "DEST_FILE_ID",
    fetchImpl: (async () =>
      metaResponse(driveFile({ trashed: false, explicitlyTrashed: true }))) as unknown as typeof fetch,
  });
  assert.equal(meta.trashed, true);
});

// ── destination verification ───────────────────────────────────────────────

test("destination verification passes when every check holds", async () => {
  const v = await verifyDriveUpload({
    ...BASE_PARAMS,
    fetchImpl: (async () => metaResponse(driveFile())) as unknown as typeof fetch,
  });
  assert.equal(v.sizeBytes, SRC_SIZE);
  assert.equal(v.md5Checksum, SRC_MD5);
  for (const check of [
    "file_exists",
    "file_id_matches",
    "not_trashed",
    "parent_folder_matches",
    "file_name_matches",
    "size_matches_source",
    "md5_matches_source",
  ]) {
    assert.ok(v.checks.includes(check), `expected check ${check}`);
  }
});

test("MD5 equality is asserted against the source checksum", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () =>
        metaResponse(driveFile({ md5Checksum: "0000000000000000000000000000dead" }))) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof DriveVerifyError &&
      err.mismatch === true &&
      /md5Checksum does not match/.test(err.message),
  );
});

test("a destination with no md5Checksum is retryable, never silently accepted", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () =>
        metaResponse(driveFile({ md5Checksum: null }))) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof DriveVerifyError && err.retryable === true && err.mismatch !== true,
  );
});

test("omitting expectedMd5 keeps the previous (capture-only) behaviour", async () => {
  const v = await verifyDriveUpload({
    ...BASE_PARAMS,
    expectedMd5: null,
    fetchImpl: (async () =>
      metaResponse(driveFile({ md5Checksum: "anything" }))) as unknown as typeof fetch,
  });
  assert.ok(v.checks.includes("md5_not_requested"));
});

test("size equality is asserted", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () =>
        metaResponse(driveFile({ size: String(SRC_SIZE + 1) }))) as unknown as typeof fetch,
    }),
    (err: unknown) => err instanceof DriveVerifyError && err.mismatch === true,
  );
});

test("wrong destination folder is rejected", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () =>
        metaResponse(driveFile({ parents: ["SOME_OTHER_FOLDER"] }))) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof DriveVerifyError && err.mismatch === true,
  );
});

test("trashed destination is rejected", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () => metaResponse(driveFile({ trashed: true }))) as unknown as typeof fetch,
    }),
    (err: unknown) => err instanceof DriveVerifyError && /trashed/.test(err.message),
  );
});

test("destination name mismatch is rejected", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () =>
        metaResponse(driveFile({ name: "some-other-name.mp4" }))) as unknown as typeof fetch,
    }),
    (err: unknown) => err instanceof DriveVerifyError && err.mismatch === true,
  );
});

test("a missing destination file reports 404 as a mismatch", async () => {
  await assert.rejects(
    verifyDriveUpload({
      ...BASE_PARAMS,
      fetchImpl: (async () =>
        metaResponse({}, 404)) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof DriveVerifyError && err.status === 404 && err.mismatch === true,
  );
});

// ── byte relay (source is opened through openSource, not a URL) ────────────

/** Captures the resumable PUT while answering the session setup. */
function stubUploadFetch(options: {
  putStatus?: number;
  putBody?: string;
  onPut?: (url: string, init: RequestInit) => void;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (init?.method === "PUT") {
      options.onPut?.(url, init);
      const status = options.putStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => JSON.parse(options.putBody ?? '{"id":"NEW_DEST_ID"}'),
      } as unknown as Response;
    }
    // resumable session setup
    return {
      ok: true,
      status: 200,
      headers: new Headers({ Location: "https://upload.example/session-1" }),
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("successful byte relay streams the opened source into the destination upload", async () => {
  const payload = new TextEncoder().encode("hello-drive-bytes");
  let opened = 0;
  const stub = stubUploadFetch({});

  try {
    const fileId = await uploadStreaming({
      accessToken: "dest-token",
      openSource: async () => {
        opened++;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payload);
              controller.close();
            },
          }),
        } as unknown as Response;
      },
      fileName: "a.bin",
      mimeType: "application/octet-stream",
      parentFolderId: "DEST_FOLDER_ID",
      fileSize: payload.length,
    });

    assert.equal(fileId, "NEW_DEST_ID");
    assert.equal(opened, 1, "the authenticated source must be opened exactly once");

    const put = stub.calls.find((c) => c.init.method === "PUT");
    assert.ok(put, "a resumable PUT must be issued");
    const headers = put!.init.headers as Record<string, string>;
    assert.equal(headers["Content-Range"], `bytes 0-${payload.length - 1}/${payload.length}`);
    assert.equal(headers["Content-Length"], String(payload.length));
    assert.equal(headers.Authorization, "Bearer dest-token");
  } finally {
    stub.restore();
  }
});

test("source read failure surfaces as a failures, not a silent success", async () => {
  const stub = stubUploadFetch({});
  try {
    await assert.rejects(
      uploadStreaming({
        accessToken: "dest-token",
        openSource: async () => {
          throw new Error("Drive media download failed: HTTP 403");
        },
        fileName: "a.bin",
        mimeType: "application/octet-stream",
        parentFolderId: "DEST_FOLDER_ID",
        fileSize: 10,
      }),
      /403/,
    );
    assert.equal(
      stub.calls.filter((c) => c.init.method === "PUT").length,
      0,
      "no upload may be attempted when the source cannot be read",
    );
  } finally {
    stub.restore();
  }
});

test("destination upload failure is reported as a failure", async () => {
  const stub = stubUploadFetch({ putStatus: 500 });
  try {
    await assert.rejects(
      uploadStreaming({
        accessToken: "dest-token",
        openSource: async () =>
          ({
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); },
            }),
          }) as unknown as Response,
        fileName: "a.bin",
        mimeType: "application/octet-stream",
        parentFolderId: "DEST_FOLDER_ID",
        fileSize: 3,
      }),
    );
  } finally {
    stub.restore();
  }
});

test("an upload with neither sourceUrl nor openSource is refused", async () => {
  await assert.rejects(
    uploadStreaming({
      accessToken: "dest-token",
      fileName: "a.bin",
      mimeType: "application/octet-stream",
      parentFolderId: "DEST_FOLDER_ID",
      fileSize: 3,
    } as never),
    /sourceUrl or openSource/,
  );
});
