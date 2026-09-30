# GPT-Live Transcript Lab

**English** | [日本語](README.ja.md)

A local-only Python web UI that visualizes `gpt-live-1` conversation processing and the execution path of a weather search.
The UI and the conversation it handles can be switched between Japanese and English.

![GPT-Live Transcript Lab demo](docs/images/gui.gif)

## Features

- Replay of synthetic events, and microphone connection to Azure OpenAI / OpenAI.
- Switching between Client delegation and Responses delegation, with a processing timeline for each mode.
- Display of the TranscriptGrouper, the TranscriptLedger (Client mode), and the audio waveform.
- Weather search via Function Calling or a Jev decision, and saving the recording as JSON. Jev is Client mode only.
- Japanese / English display language, including the voice instructions, prompts, replay conversations, and weather summaries.

## Getting started

Python 3.11 or later is required. The browser bundle is prebuilt and included, so Node.js is not needed for normal use.
Run the following commands at the root of this repository.

### Windows (PowerShell)

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

### macOS / Linux

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app.py
```

Open **http://localhost:8765** in your browser. To change the port, add `--port 8875` to the start command.

**To try it without an API**: select Client delegation, turn OFF "Run weather search" in the "Function execution playground", then select "Replay".
If it stays ON, even a replay may incur charges for the decision API.

## Display language

Use the **English** / **日本語** button in the upper right to switch languages, or open **http://localhost:8765/?lang=en**.
The choice is remembered in the browser; without it, the browser language decides (Japanese for `ja`, otherwise English).
Switching reloads the page and discards unsaved recordings, and it is disabled during a live connection.
In English mode, the assistant speaks English, and the app expects English requests such as "What's the weather in Tokyo right now?".
Details: [Display language](docs/usage.md#display-language).

## Delegation modes

Select the mode with "Delegation mode" at the top of the screen before connecting. It cannot be changed while connected.
**Changing the mode resets the recording. Save any recording you need as JSON first.**

| Mode | Context and decision | Display and constraints |
| --- | --- | --- |
| Client delegation | The app sends the Ledger conversation to Function Calling or Jev | Ledger, model decision, function execution, commentary send/ACK. Replay and runs without audio are also available |
| Responses + Function Calling | GPT-Live supplies the conversation context to the Responses model | The Ledger is neither created nor used. Responses events, function execution, result submission, explicit continuation, completion/failure. Live only |

Even in Responses mode, the app validates and executes functions. It returns the result with `response.item.create` and continues with `response.create`.
Search OFF only stops execution of the weather function. The voice session and the Responses model may still incur charges when it is OFF.
For details, see the [delegation mode guide](docs/usage.md#delegation-mode) and the [official specification](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-delegation).

## API connection settings

Only if you use a real API, create `.env` at the root based on [.env.example](.env.example).
Existing environment variables take precedence. Restart the server after changing settings.

| Purpose | Settings |
| --- | --- |
| Azure live voice | `LIVE_PROVIDER=azure`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| OpenAI live voice | `LIVE_PROVIDER=openai`, `OPENAI_API_KEY` |
| Client + Function Calling | Azure connection settings and `AZURE_OPENAI_BACKEND_DEPLOYMENT` (default `gpt-6-luna`) |
| Client + Jev decision | `TYPESAFE_API_KEY`. Optionally `TYPESAFE_MODEL` (default `jev-latest`) and `JEV_CONFIDENCE_THRESHOLD` (default `0.75`) |
| Responses + Function Calling | Live connection settings and an optional `LIVE_RESPONSES_MODEL`: a deployment name in the same resource for Azure, or a model ID for OpenAI |

Azure uses `AZURE_OPENAI_API_KEY` or an Azure CLI account signed in with `az login`.
The latter requires the `Cognitive Services OpenAI User` role on the target resource.
Function Calling in Client mode uses an Azure `gpt-6-luna` deployment regardless of the voice provider.
If the Responses mode model is omitted, Azure uses `AZURE_OPENAI_BACKEND_DEPLOYMENT` (default `gpt-6-luna`) and OpenAI uses `gpt-5.5`. Check model availability and access permissions with your provider separately.
Live voice requires model access permissions and browser microphone permission.
For details, see [Connection settings](docs/usage.md#connection-settings) and the [official Azure instructions](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-webrtc).

## Structure

| Path | Role |
| --- | --- |
| [app.py](app.py) | HTTP / WebSocket server, voice session creation |
| [lab/](lab/) | Conversation state, authentication, decision models, weather search, language selection |
| [static/](static/) | Browser UI, English dictionary, and prebuilt bundle |
| [frontend/](frontend/), [scripts/](scripts/) | Bundle entry point, build and packaging scripts |
| [vendor/](vendor/) | Pinned copies of official helpers and their licenses |
| [tests/](tests/) | Python / Node.js tests |
| [docs/](docs/) | Usage guide and detailed specification |

## Documentation

- [Usage guide, detailed specification, and development steps](docs/usage.md)
- [Security and data handling](SECURITY.md)

**Do not expose the server to the internet or a LAN.** The real APIs are paid services.
The license for the original parts is unspecified. For the terms of bundled code, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
