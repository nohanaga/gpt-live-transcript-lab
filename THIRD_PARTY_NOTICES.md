# Third-party notices

## Application licensing

No license has been selected for the original application code and documentation.
The licenses below apply to the identified third-party components, not to the
repository as a whole. Publication of this source does not add an application-wide
MIT or Apache-2.0 grant.

## OpenAI Cookbook: TranscriptLedger

- Repository: https://github.com/openai/openai-cookbook
- Commit: `5986832a554169dc87285b1b0b396941f235a62e`
- Original path: `examples/audio/duplex_voice_agent_evaluation/assistants/client/memory.py`
- Local path: `vendor/openai_cookbook/memory.py`
- License: MIT; full text in `vendor/openai_cookbook/LICENSE`.
- Copyright (c) 2025 OpenAI.

The upstream file is unmodified. The application-specific state snapshots, input
validation, handoff inspection and deterministic stub are in `lab/state.py`,
not changes to the official sample. The snapshot adapter reads the sample's
private `_segments` for inspection and uses a copy for non-consuming previews.

## OpenAI Node SDK: TranscriptGrouper

- Repository: https://github.com/openai/openai-node
- Commit: `5d258e4e82d7655fa82a4688fc04c53359417d27`
- Source directory: `vendor/openai-node/`
- License: Apache License 2.0; full text in `vendor/openai-node/LICENSE`.

The official TypeScript helper and its runtime dependencies are vendored at the
fixed commit and bundled for the browser. The browser bundle is a generated
artifact, not a Python approximation of the algorithm. Diagnostic displays and
the surrounding UI are application code. No official delegation policy is
attributed to TranscriptGrouper: the helper handles display grouping only.

The browser distribution includes [static/vendor/LICENSE.openai-node](static/vendor/LICENSE.openai-node).
The build script retains legal comments and copies the upstream license alongside
the bundle. See [scripts/build-grouper.mjs](scripts/build-grouper.mjs).

## Dependencies and external services

Python and npm dependencies are installed separately from the pinned requirement
and lock files. Their own licenses continue to apply; their installed distributions
are not included in the source delivery.

Open-Meteo is an external data service, not vendored code. Weather results contain
source URLs. Review its API terms and data attribution requirements before reuse,
especially commercial use:

- https://open-meteo.com/en/docs
- https://open-meteo.com/en/docs/geocoding-api
- https://open-meteo.com/en/terms
- https://open-meteo.com/en/licence

API access and billing for Azure OpenAI, OpenAI and TypeSafe are separate from the
licenses of the source files in this repository.
