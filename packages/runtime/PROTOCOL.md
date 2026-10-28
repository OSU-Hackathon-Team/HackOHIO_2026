# Splice sidecar protocol v1

One UTF-8 JSON object per line, both directions, hard cap 8 MiB per line.

Request from host to sidecar (`stdin`):

```json
{"id":"1","op":"add_i64","args":{"a":{"$int":"9223372036854775807"},"b":{"$int":"1"}}}
```

`args` is already encoded with the operation's request `WireObject` schema (see
`packages/contracts/src/wire.ts`). The sidecar owns no schema knowledge beyond the generated
shim; the host validates before sending and after receiving.

Success (`stdout`):

```json
{"id":"1","ok":true,"value":{"sum":{"$int":"-9223372036854775808"}}}
```

Error:

```json
{"id":"1","ok":false,"error":{"code":"overflow","message":"i64 overflow"}}
```

Progress/stream events before the terminal response:

```json
{"id":"1","event":{"index":{"$int":"0"},"text":"hello"},"ok":null}
```

The `event` field is encoded with the operation's streaming `event` schema. Exactly one of
`event`/`ok` is present per line. A terminal line has `ok` boolean.

Rules:

- Requests are processed sequentially unless the package declares concurrent operations.
- Unknown `op`, malformed lines, or oversized lines terminate the sidecar with a nonzero exit.
- The host enforces deadlines and kills the process on timeout or abort; the sidecar must not
  spawn children, open network sockets, or read outside the supplied workspace.
- `stderr` is captured for diagnostics and capped; it is never parsed as protocol output.
- The host test suite must include: int64 bounds, NaN/Infinity, bytes, typed errors, malformed
  input, timeout kill, abort, crash restart, and permission denial.
