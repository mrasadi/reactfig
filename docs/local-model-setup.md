# Running ReactFig fully local

ReactFig's AI-assisted tools (`generate_design_ir`, etc.) talk to any
`ANTHROPIC_API_KEY`-based provider or any OpenAI-compatible endpoint —
see `docs/environment.md` for the full variable reference. This doc
walks through one concrete way to run everything, including the model,
entirely on your own machine, with no hosted API required.

Stack: **Ollama** (serves the model) → **LiteLLM** (OpenAI-compatible
proxy in front of it, so you can register multiple local models under
one endpoint) → **ReactFig's MCP server** (talks to LiteLLM) → an
agent/editor of your choice (e.g. [opencode](https://opencode.ai)) that
calls ReactFig's MCP tools.

```
Agent / Editor (MCP client)
        │
        ▼
ReactFig MCP server  ──►  LiteLLM (localhost:4000)  ──►  Ollama (localhost:11434)
```

None of this is required to build or test ReactFig itself — it's only
for using the AI-assisted MCP tools without a hosted model provider.

## 1. Ollama

Install Ollama and pull a model with vision + tool-calling support (the
`generate_design_ir` tool needs both). Tune resource usage for your
machine, e.g.:

```bash
export OLLAMA_NUM_PARALLEL=1        # serialize requests
export OLLAMA_MAX_LOADED_MODELS=2   # cap models resident in memory at once
export OLLAMA_KEEP_ALIVE=30m
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_CONTEXT_LENGTH=131072  # ceiling — every num_ctx below must stay under this
```

## 2. LiteLLM (optional, but recommended for local setups)

A thin proxy that exposes any number of Ollama-served models as one
OpenAI-compatible endpoint, so `REACTFIG_MODEL_BASE_URL` never has to
change when you swap the underlying model. Example `config.yaml`:

```yaml
model_list:
  - model_name: vision
    litellm_params:
      model: ollama_chat/<your-model>
      api_base: http://localhost:11434
      api_key: "ollama"
      num_ctx: 131072
      timeout: 600
      keep_alive: "20m"
    model_info:
      max_input_tokens: 131072
      max_output_tokens: 131072

litellm_settings:
  drop_params: true
  num_retries: 2
  request_timeout: 180

general_settings:
  master_key: sk-local-1234   # placeholder — most local setups don't check this
  port: 4000
```

Run it with `litellm --config config.yaml`.

If you'd rather point ReactFig straight at Ollama and skip this step,
just set `REACTFIG_MODEL_BASE_URL=http://localhost:11434/v1` instead of
`:4000`.

## 3. ReactFig's MCP server

```bash
export REACTFIG_MODEL_PROVIDER=openai-compatible
export REACTFIG_MODEL_BASE_URL=http://localhost:4000/v1   # or :11434 if skipping LiteLLM
export REACTFIG_MODEL_NAME=vision
export REACTFIG_MODEL_API_KEY=sk-local-1234
export REACTFIG_MODEL_VISION=true
export REACTFIG_MODEL_TOOLS=true
# Optional, while diagnosing a slow/failing call — see ADR 0013:
export REACTFIG_DEBUG=true
export REACTFIG_DEBUG_LOG_FILE=/tmp/reactfig-debug.log
```

Then start it (`node packages/mcp/dist/server.js --project /path/to/your-react-app`)
or register it with your agent/editor as an MCP server.

## 4. Registering with an MCP client (e.g. opencode)

```json
{
  "mcp": {
    "reactfig": {
      "type": "local",
      "enabled": true,
      "command": ["node", "/path/to/reactfig/packages/mcp/dist/server.js", "--project", "."],
      "timeout": 600000,
      "env": {
        "REACTFIG_MODEL_PROVIDER": "openai-compatible",
        "REACTFIG_MODEL_BASE_URL": "http://localhost:4000/v1",
        "REACTFIG_MODEL_API_KEY": "sk-local-1234",
        "REACTFIG_MODEL_NAME": "vision",
        "REACTFIG_MODEL_VISION": "true",
        "REACTFIG_MODEL_TOOLS": "true"
      }
    }
  }
}
```

Note `--project "."` points at the *target* React app you're capturing
from (your editor's workspace root), not at ReactFig's own checkout —
see `docs/environment.md`'s "Configuration groups" section for why
these are easy to mix up and what happens if you do.

## 5. Optional: semantic search over your own captures (Qdrant)

If you want to index captured evidence or Design IR documents for
semantic search/retrieval (e.g. from an agent), a local
[Qdrant](https://qdrant.tech) instance plus an embedding model served by
Ollama works well and needs no ReactFig-specific wiring:

```bash
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text:latest
```

This is not part of ReactFig's own pipeline — it's an optional piece
some users add on top when building their own agent workflows around
captured artifacts.

## Troubleshooting

- **Timeouts on `generate_design_ir` with a local model** — local
  models are slower than hosted ones; see ADR 0013 for the specific
  failure mode this caused and how to diagnose it with
  `REACTFIG_DEBUG=true`.
- **"missing REACTFIG_MODEL_BASE_URL / NAME"** — deliberate: these have
  no fallback for `openai-compatible`, so a misconfigured environment
  fails immediately at startup instead of later, mid tool-call. See
  `docs/environment.md`.
