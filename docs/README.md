# Documentation

Start with the root [README](../README.md) for what ReactFig does and
how to get it running. This folder is the deeper reference material.

| Doc | What it's for |
|---|---|
| [architecture.md](architecture.md) | System design: principles, package boundaries, how a capture becomes a Figma document. Read this first if you're contributing. |
| [environment.md](environment.md) | Every environment variable / CLI flag ReactFig reads, what each does, and its default. |
| [local-model-setup.md](local-model-setup.md) | Running the AI-assisted tools fully local (Ollama + LiteLLM), no hosted API required. |
| [design-ir/README.md](design-ir/README.md) | The `design-ir/v1` schema — ReactFig's exporter-independent representation of a captured UI. |
| [analyzer/evidence-model.md](analyzer/evidence-model.md) | The `ComponentEvidence` contract between browser capture and AI interpretation. |
| [analyzer/ai-orchestration.md](analyzer/ai-orchestration.md) | How evidence becomes a validated Design IR document: usage and provider setup. |
| [figma-plugin/feasibility.md](figma-plugin/feasibility.md) | Design IR → Figma Plugin API mapping decisions and constraints. |
| [adr/](adr/) | Architecture Decision Records — the running history of *why* things are shaped the way they are. Check here before proposing a restructure; see `CONTRIBUTING.md`. |

For what changed between versions, see the root
[CHANGELOG.md](../CHANGELOG.md).
