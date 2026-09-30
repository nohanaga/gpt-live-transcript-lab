# Security and Data Handling

**English** | [日本語](SECURITY.ja.md)

## Summary

This app is a tool for observing conversation processing, intended for use by the developer on localhost only.
Even if you publish the source code, do not expose the running HTTP / WebSocket server to the internet or a LAN.
There is no login, no per-user authorization, no persistent audit log, and no spending limit management.

## Connections and authentication

- [app.py](app.py) binds to `127.0.0.1`. It restricts the Host header and checks the Origin for session creation and WebSockets, but this is not a substitute for user authentication.
- Set API keys in `.env` at the project root or in environment variables. For Azure, if no key is set, `AzureCliCredential` uses the identity signed in to the Azure CLI. There is no automatic fallback to Managed Identity or other credentials.
- Only the session ID and the SDP answer are passed to the browser. API keys and Entra tokens stay on the server. The SDP itself also contains connection information, so do not share it.
- The "configured" indication from `GET /api/config` does not verify authentication to the service, model access permissions, or network reachability.
- "Run weather search" is ON by default. For a free replay, turn it OFF before starting. When it is ON, even a synthetic delegation may call the decision API.
- Replay is available in Client mode only. In Responses mode, the voice session and the delegated model may incur charges even with search OFF. OFF only restricts execution of the weather function; it does not stop model calls.

Sources: [server](app.py), [configuration and authentication](lab/provider.py), [browser replay and execution control](static/app.js),
[Azure GPT-Live WebRTC](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-webrtc).

## Information sent externally

| Destination | Main data sent | Condition |
| --- | --- | --- |
| Azure OpenAI or OpenAI Live | Session instructions, SDP, microphone audio, replies to delegations | During a live connection. Audio is transferred via WebRTC between the browser and the service |
| Azure OpenAI Responses API | Accumulated SRT, decision instructions, the weather function's JSON Schema, function results | When Client + Function Calling is selected and run |
| Responses model configured for Live (Azure OpenAI / OpenAI) | Conversation context supplied by GPT-Live, decision instructions, the weather function's JSON Schema, function results returned by the app | Responses delegation. The Ledger is not used |
| TypeSafe API | Accumulated SRT, the current SRT, 17 choices and decision instructions | When Client + Jev is selected and run |
| Open-Meteo | Geocoding by city name, a weather request using the retrieved coordinates | When the weather function runs |

The SRT contains the USER / ASSISTANT conversation. Switching the decision method within Client mode does not clear the accumulated context,
so conversation previously processed with another method may be sent to the newly selected provider.
Changing the Client / Responses delegation mode resets the local recording, but that does not delete data that has already been sent.
This app's local retention policy does not guarantee the data retention or usage terms of external services.
`store: false`, set on Client-mode Responses requests, also does not mean that no service stores anything at all.
This app does not specify `store: false` in the Responses delegation settings.

Sources: [execution management](lab/execution.py), [Responses requests](lab/backend.py), [Jev requests](lab/jev.py),
[weather retrieval](lab/weather.py), [GPT-Live delegation](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-delegation), [TypeSafe API](https://docs.typesafe.ai/api), [Open-Meteo](https://open-meteo.com/en/docs).

## Storage and sharing

The conversation and timeline are kept in the memory of the browser and of the server serving the observation WebSocket.
The conversation is not automatically saved to files, and raw audio is not recorded. The waveform is aggregated amplitude values.
A manually saved JSON file may contain the conversation text, the actual model request bodies, function results, related IDs, and waveform aggregates.
Exports are not anonymized public material. The same caution applies to screenshots and exception logs.

`.gitignore` only helps reduce accidental commits of secrets and exports. It does not remove information from files that are already tracked or from Git history.
Do not attach `.env`, authentication headers, SDP, or conversation exports to issues, pull requests, or public repositories.
If you leak a secret, revoke and reissue the affected credentials before cleaning up history.

The theme and display language choices are stored in the browser's `localStorage`; they contain no conversation data.

Sources: [browser recording](static/app.js), [waveform processing](static/audio-waveform.js), [server state management](lab/state.py).

## Execution limits

The only allowed operation is a current-weather search for 12 cities. Model arguments and Jev's choices, probabilities, and confidence are validated,
but there is no separate validator that re-evaluates the user's intent. Confidence is not proof of correctness or user approval.
In Client mode, a new delegation suppresses returning an older result, but there is no guarantee that already-started external requests or charges are cancelled.
Responses mode processes each delegation ID independently; a new delegation alone does not automatically cancel an older request.
Execution OFF is checked before retrieving the weather. It does not guarantee cancellation of a search already in progress, nor prior review of model output automatically injected into Live.
If you adapt this implementation for payments, reservations, deletions, or similar operations, you need separate permission checks, explicit approval, and duplicate-execution prevention.

Sources: [argument validation](lab/backend.py), [Jev validation](lab/jev.py), [cancellation handling](lab/execution.py),
[execution responsibility in Client delegation](https://developers.openai.com/api/docs/guides/live-delegation).

## Reporting issues

Prepare minimal reproduction steps that contain no secrets or real conversations.
Do not post issues containing sensitive information in public issues; use a private reporting channel provided by the maintainer of the published repository.
This distribution does not define a dedicated contact, response deadline, or security guarantee.
