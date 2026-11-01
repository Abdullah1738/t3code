# Desktop lease PreToolUse guard

`desktop_lease.py` is a standalone Claude Code / Codex command hook. It reads a
single `PreToolUse` event on stdin. On success it emits nothing, leaving the
normal permission flow untouched; on refusal it emits the documented
`hookSpecificOutput.permissionDecision: "deny"` shape. A synchronous matcher
must cover *all* `cua-driver` and `node_repl` MCP tool names, including their
underscore-normalized names and nested calls from code mode. Neither home
configuration nor trust is installed by this directory.

## Not a desktop-enforcement boundary

This is a guardrail, **not a release-ready global lock**. In particular:

- C1's verified caller identity and C2's hook integration are not yet merged.
  The hook intentionally fails closed when its identity proof or resolver is
  unavailable. The resolver described below is a proposed adapter contract;
  neither the endpoint nor its credential provisioning is established here.
- A status GET and the subsequent action are separate operations. Stop, expiry,
  release, or a second controller can race between them; the hook cannot fence
  an already-admitted call. Even a successful check does not start or finish
  an in-flight call in the lease service. Lease admission must be atomic with
  dispatch in a trusted proxy/driver, and release must wait for verified
  quiescence; status polling or a hook alone cannot provide that guarantee.
- Exact status ownership is only meaningful if the lease acquisition endpoint
  also binds its request to the real caller. An operate credential plus
  caller-supplied `rootThreadId` / `childThreadId` is not such a binding.
- Arbitrary persistent Node REPL JavaScript is not statically decidable. A
  previous invocation can save an alias, register a callback, spawn a process,
  or acquire an IPC connection; imports, property names, scripts and commands
  can be computed. Timers, unresolved promises, workers, detached children and
  IPC may continue after a tool call returns or after the lease is released.
  The hook only allows literal/operator expressions without a lease. It requires
  a lease for everything else, including harmless `console.log`, variables,
  JSON manipulation and filesystem reads. This is a deliberate conservative
  tradeoff and **does not satisfy** the requirement that all ordinary JS pass
  lease-free. Even a literal expression can run while background work started by
  an earlier invocation remains active. A controlled REPL proxy/isolated
  capability model, with per-operation admission and cancellation/quiescence,
  is needed to make both requirements true.
- Successful hook return, JSON deny, and availability are not proof the host
  actually ran and honored the hook. Codex documents hook trust review,
  disabled/skipped hooks, specialized tool paths, and failure/timeout paths
  that may continue the tool call. Verify the pinned versions and real nested
  code-mode invocation before use; install/trust/failure policy is out of scope.
  A missing executable, process kill, host timeout, or skipped hook cannot be
  made fail-closed by this script itself.
- Direct shell, other MCP servers, aliases of servers with unrelated names,
  native sockets and other unhooked tools can reach the desktop without this
  hook. The tool-name list assumes the canonical configured `cua-driver` and
  `node_repl` MCP server names. A native-subagent caller whose true identity
  cannot be independently resolved must be denied, never attributed to its
  parent merely because it shares a native session ID.
- Lease `scope` and `mode` are validated as present/well-formed but not matched
  against action targets. Fallback may legitimately use a native lease; neither
  this check nor a lease grants authorization or overrides a native policy
  denial. Do not use fallback to evade a rejection.

For the known cua-driver surface, genuinely read-only calls are allowed without
identity or a lease; `page`, `browser_dialog` and `check_permissions` inspect
their arguments, and an unknown operation on that server requires a lease.
Node REPL `js_reset` and module-dir changes also require a lease because a
persistent kernel may have running work. Capture and browser-state reads remain
allowed; operators still need the ordinary privacy rules for them.

## Proposed integration contract

The hook uses `T3_CONTROL_URL` / `T3_CONTROL_TOKEN`, then an explicit
`T3_CONTROL_TOKEN_FILE`, then `~/.robob/components/t3ctl.json`, then the old
`~/.robob/ardud-control.json`, in the same precedence as the control client.
Files must not be group/world accessible. Missing/invalid credentials, failed
requests, timeouts, redirects, unexpected HTML and malformed status fail closed.
The default endpoint is `GET /api/ardud/control/desktop-lease`, with response
`{"lease": {rootThreadId, childThreadId, taskId, scope, mode, acquiredAt,
heartbeatAt, state} | null, "queue": [...]}`. Only `state: "held"` and exact
caller `threadId` / `rootThreadId` match pass. No new credential is issued here.

As a placeholder for C1, each protected call also requires a trusted, per-call
`T3_HOOK_IDENTITY_PROOF` and sends the hook-provided native `session_id`,
`tool_use_id`, and optional `agent_id` to
`POST /api/ardud/control/hook-identity/resolve`:

```json
{"proof":"<opaque>","nativeSessionId":"<native>","toolUseId":"<call>","agentId":null}
```

A successful resolver must return:

```json
{"caller":{"verified":true,"nativeSessionId":"<native>","toolUseId":"<call>","agentId":null,"threadId":"<caller>","rootThreadId":"<root>"}}
```

The server must independently authenticate and bind the proof to the specific
provider session, native subagent (if any), turn/tool call and Robob thread;
echoing caller-supplied fields or trusting an arbitrary environment variable
would not be verification. An environment proof readable by unrelated shell or
REPL code is not an isolation boundary. Integrate with C1's actual attested
contract rather than exposing this provisional shape without those properties.
The existing `threads/by-native/:sessionId` lookup is not a substitute: it
does not prove the particular tool call or distinguish all native subagents.

## Focused test

From the worktree root:

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 integrations/harness-hooks/tests/test_desktop_lease.py
```

Tests use an in-process stub HTTP server and fake identity/credentials only; they
do not launch the REPL, Sky, a GUI or a browser. They establish script behavior,
not compatibility with an actual hook runtime, the C1 resolver, credentials,
or the concurrently implemented lease endpoint.
