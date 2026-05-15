<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

## Upstream Proxy Auth Resolution

`lookupProxy` in `src/proxy/handler.ts` resolves upstream proxy authentication with this priority:

1. **PAC file embedded auth** — `proxy.username` from parsed `PROXY user:pass@host:port`
2. **Environment variable fallback** — `process.env.PROXY_USER` / `process.env.PROXY_PASS`
3. **Client header** — `req.headers['proxy-authorization']` (Basic auth only)

The `.env` file is auto-loaded via `import 'dotenv/config'` in `src/index.ts`.
PAC auth always takes priority over env vars; env vars take priority over client headers.

## Log Level System

The `Logger` in `src/logger.ts` supports both a verbose toggle and a minimum log level:

| Level | Priority | Description |
|-------|----------|-------------|
| `DEBUG` | 0 | All messages |
| `INFO` | 1 | Default — informational + warnings + errors |
| `WARN` | 2 | Warnings + errors |
| `ERROR` | 3 | Errors only |

When `verbose` is `false`, no output is produced regardless of `minLevel`.
`withRequestId()` preserves the current `minLevel` for child loggers.

### CLI flags

- `-v` — sets `verbose=true`, keeps default `minLevel=INFO`
- `--log-level debug` — sets `verbose=true, minLevel=DEBUG`
- `--log-level error` — sets `verbose=true, minLevel=ERROR`
- `--log-level` implies `-v` — no need to pass both
- `-w`, `--watch` — uses `fs.watch` to watch the PAC file and auto-reload the engine on change

Constructor: `new Logger(verbose, minLevel='INFO', requestId='')`

## Connection Pool & CONNECT Tunnel Behavior

`TcpConnectionPool` in `src/proxy/connection-pool.ts` manages reusable TCP connections to upstream proxies.

### Lifecycle

1. `handleConnect` in `src/proxy/handler.ts` calls `connPool.acquire(host, port)` to get a TCP connection
2. Sends CONNECT request over the acquired connection
3. **On success (2xx)**: connection is consumed by the TCP tunnel — `serverConn.pipe(clientSocket)` and vice versa. When the tunnel closes, the connection is **destroyed** (not returned to pool).
4. **On failure (non-2xx)**: the connection is **destroyed** via `serverConn.destroy()` (not returned to pool). This prevents reusing "spent" TCP connections, because some enterprise proxies (e.g., Pinacolada) reject subsequent CONNECT requests on the same TCP connection.

### Why not pool rejected CONNECT connections?

Some upstream proxies aggressively track per-connection state. Once a CONNECT attempt (even a failed one with 407) is made on a TCP connection, the proxy treats the connection as "consumed" and rejects any future CONNECT on the same connection. Returning the connection to the pool after a failure creates a downward spiral:

```
Failed CONNECT → release to pool → next request reuses it → rejected again → released again → ...
```

Destroying the connection after failure ensures every CONNECT attempt gets a fresh TCP connection, which is always accepted by the upstream.
