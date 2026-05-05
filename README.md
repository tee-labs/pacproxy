# pacproxy

GitHub repository configured with [OpenCode](https://opencode.ai) AI coding agent and [code-review-graph](https://github.com/anomalyco/code-review-graph) for intelligent code review and knowledge graph–powered development.

## What Is This?

`pacproxy` is a development environment scaffold that integrates:

- **OpenCode** — AI coding agent that responds to `/oc` commands in GitHub Issues and PR review comments.
- **code-review-graph** — MCP server that builds a knowledge graph of your codebase, enabling semantic search, impact analysis, risk-scored code reviews, and architecture exploration.

## How It Works

### OpenCode Integration

When you comment `/oc` on an **Issue** or **PR review comment**, the [GitHub Actions workflow](.github/workflows/opencode.yml) triggers OpenCode to act on your request. For example:

- `/oc fix the bug described above` — OpenCode analyzes the issue and opens a fix PR.
- `/oc review this PR` — OpenCode performs a structured code review.
- `/oc implement the feature described in this issue` — OpenCode writes the code.

### code-review-graph MCP

The `code-review-graph` MCP server provides knowledge graph tools that OpenCode uses instead of (or alongside) traditional file scanning:

| Tool | Purpose |
|------|---------|
| `detect_changes` | Risk-scored change analysis |
| `get_review_context` | Token-efficient source snippets for review |
| `get_impact_radius` | Blast radius of a change |
| `get_affected_flows` | Execution paths impacted by changes |
| `query_graph` | Trace callers, callees, imports, tests |
| `semantic_search_nodes` | Find functions/classes by name or keyword |
| `get_architecture_overview` | High-level codebase structure |
| `refactor_tool` | Plan renames, find dead code |

### Skills

The project includes pre-configured skills for OpenCode:

- **Review Changes** — Structured code review using the knowledge graph (risk levels, test coverage, suggestions).
- **Explore Codebase** — Navigate and understand codebase structure via the graph.
- **Debug Issue** — Systematic debugging with graph-powered code navigation.
- **Refactor Safely** — Plan and execute safe refactoring using dependency analysis.

## Project Structure

```
pacproxy/
├── .github/workflows/opencode.yml    # GitHub Actions workflow for OpenCode triggers
├── .claude/skills/                   # OpenCode skill definitions
│   ├── review-changes.md
│   ├── explore-codebase.md
│   ├── debug-issue.md
│   └── refactor-safely.md
├── .code-review-graph/               # Knowledge graph database (gitignored)
├── .opencode.json                    # MCP server configuration
├── AGENTS.md                         # Agent instructions for code-review-graph usage
└── README.md                         # This file
```

## Setup

### Prerequisites

- Python 3.10+
- Node.js 22+
- GitHub repository with Actions enabled

### Configuration

1. **MCP Server** — Configured in `.opencode.json`:
   ```json
   {
     "mcpServers": {
       "code-review-graph": {
         "command": "code-review-graph",
         "args": ["serve"],
         "type": "stdio"
       }
     }
   }
   ```

2. **GitHub Actions** — The workflow in `.github/workflows/opencode.yml` handles:
   - Triggering on `/oc` or `/opencode` comments
   - Installing `code-review-graph` and building the graph
   - Running OpenCode with the appropriate model and API keys

3. **Required Secrets** — Configure these in your GitHub repository settings:
   - `API_KEY` — OpenCode API key
   - `TAVILY_API_KEY` — Tavily search API key (for web research)
   - `CONTEXT7_API_KEY` — Context7 API key (for library documentation)
   - `DEFAULT_MODEL` — (optional) Model override, defaults to `x-openai/ark-code-latest`

## Usage

### Triggering OpenCode

Comment on any **Issue** or **PR review comment**:

```
/oc fix the bug described above
```

```
/oc implement this feature
```

```
/oc review my changes
```

OpenCode will analyze the context, execute the task, and push changes automatically. A PR is created if the command was issued on an issue.

### Knowledge Graph

The code-review-graph is automatically built during each workflow run. It provides:

- **Semantic search** — Find code by meaning, not just text.
- **Impact analysis** — Understand what breaks when you change something.
- **Risk scoring** — Automatically assess the risk level of changes.
- **Test coverage mapping** — Link code changes to their tests.

## License

MIT
