# SFTP library paths

Library paths can point at a local mounted folder or at a remote directory over SFTP.
The scan pipeline (companion discovery, embedded extraction, auto-translate, exports,
offset editing) works the same way in both modes; the difference is where file reads and
writes go.

## How it works

`ILibraryFileSystem` (BCookieSubs.Shared, `Services/Storage/`) is the single file-access
boundary for library paths:

- `LocalLibraryFileSystem` — plain local I/O, the previous behavior.
- `SftpLibraryFileSystem` — one SSH.NET `SftpClient` per instance, opened with the
  path's stored credentials.
- `ILibraryFileSystemFactory` creates the right one per `LibraryPath`.

Remote paths are POSIX strings, so path math (`Path.Combine`, containment checks)
is unchanged; only the I/O goes through the abstraction.

## Credentials

Passwords, private keys and key passphrases are **not** database columns. They are
stored encrypted in `app_secrets` through `SecretsService` (AES-256-GCM with
`SECRET_ENCRYPTION_KEY`), keyed `sftp:<pathId>:password`, `:privateKey`, `:keyPassphrase`.
Consequences:

- Secrets are write-only from the browser: the form shows "configured" state and a
  replace/remove checkbox, and never receives the stored value back.
- Secrets are never logged and never sent through SignalR.
- Deleting a library path deletes its secrets with it (the row delete cascades the
  path; secrets are removed best-effort on create rollback).

## Host-key trust

Every SFTP connection verifies the server's host key against a pinned SHA256
fingerprint stored on the path row. There is no accept-unknown-keys mode anywhere.

Trust flow (Test Connection button on the Library Paths form):

1. First test connects with no fingerprint accepted. The handshake is rejected, the
   server's presented fingerprint is shown, and the user is asked to verify it.
2. "Trust this host key and connect" re-runs the test accepting exactly that one
   presented key (not an accept-all flag), so the verified key is the one trusted.
3. Saving an SFTP path requires the pinned fingerprint; the scanner connects only
   when the presented key matches it.

If the server later presents a different key (reinstall, key rotation, or a
man-in-the-middle), scans fail with a clear host-key-changed error until an
administrator verifies and re-pins the new fingerprint via Test Connection.

## Staging (why SFTP libraries are slower)

Embedded-subtitle work (ffprobe track discovery, extracting a `.sup`/`.sub`/SRT
stream) needs a real local file, so the pipeline stages only the files it needs:

- `LibraryStaging.ScanDir(libraryPathId)` for scan-time probing — a video with
  companion subtitles is never downloaded; only videos that need embedded-track
  probing or extraction are staged, once per scan pass.
- `LibraryStaging.WhisperDir(jobId)` for Whisper transcription (the whole media file
  is needed anyway).
- `LibraryStaging.OcrStagingDir` receives only the subtitle image files (`.sup` or
  `.sub`+`.idx`), streamed — not the video.

Staged files are cleaned up in `finally` blocks (and a dispatcher sweep on job
terminal states). The staging root is `/work/staging` in containers, overridable with
`BCOOKIESUBS_STAGING_DIR`.

Local libraries never stage — everything reads from disk as before.

## Test Connection

`POST /library-paths/test-sftp` runs `SftpConnectivityTest`, reporting separate steps:
DNS resolution, TCP reachability, SSH handshake (with host-key handling above),
authentication, remote-root existence, and read access (one directory listing).
Errors are safe to show in the browser and credentials are never echoed.

The endpoint uses the entered credentials; when editing an existing path, empty
credential fields fall back to the stored secrets so a test works without re-entering
them.