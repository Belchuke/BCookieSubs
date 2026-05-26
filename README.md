# BCookieSubs

A self hosted app that translates subtitle files (`.srt`) using local or cloud LLMs, with a focus on watch along quality rather than literal word by word translation.
Supports a built-in scanner for media libraries (movies / series), automatic embedded-subtitle extraction (MKV / MP4), and a judge-model voting flow that picks the best candidate translation per chunk.

> **Status: alpha.** Things will move around, schemas will change, and there is no upgrade path yet. **Always back up your SQLite database before updating** — breaking changes can happen at any time.

---

## Why did I build this project?

I have a Thai girlfriend and most of the movies I own have English subtitles.
Thai subtitles? Almost never.

So I wrote a little script to translate `.srt` files from English to Thai so we could watch movies together. Then I thought, "what if I had a tiny UI for it?" and then "what if multiple models voted on the best translation?" and then "what if it could scan a folder?" and a few months later it became this.

**Use it on subtitles for media you legally own.** I do not endorse or support piracy in any form. This project was built for couples and families like mine where partners speak different languages and struggle to find subtitles in the right language for their media collection. It doesn't download, host, or distribute any copyrighted content; it only operates on subtitle files you provide, on your own machine. Translate subtitles for movies and shows you legitimately own so your loved ones don't miss out on the dialogue.

---

## How it works

At a high level:

1. You give it an `.srt` file (or point it at a folder of media it'll find / extract subtitles itself).
2. It splits the subtitle into chunks of N lines (configurable).
3. For each chunk, every active translation **model × prompt** combination produces a candidate translation in parallel.
4. A **judge** model is shown all candidates and picks the best one (with a fallback judge if the primary fails or rejects them all).
5. The winners are stitched back together into a translated `.srt`, optionally written next to the original media file.

Models can be:

- **Local Ollama** models — runs on your hardware, no API costs, fully private.
- **Ollama Cloud** models — large models you couldn't run locally; needs an API key.
- **OpenAI** / **Anthropic** — supported if you'd rather use ChatGPT / Claude (but not tested).

The app uses [TheMovieDB](https://www.themoviedb.org) to detect what movie / show a filename refers to (so prompts get accurate title, year, and genre context), which noticeably improves translation quality for proper nouns and idioms.

---

## Prerequisites

Hard requirements:

- **Docker + Docker Compose v2** (Docker Desktop on macOS / Windows, or `docker.io` + the compose plugin on Linux).
- Disk space for the database (small) and any Ollama models you choose to install (large — many GBs each).
- A **TheMovieDB API key** for media name detection. It's free: create an account at <https://www.themoviedb.org>, go to _Settings → API_, request a developer key. v3 auth (the simple API key string) is all you need.

Recommended:

- An **Ollama account** if you don't have hardware to run large local models. Get one at <https://ollama.com>, then create an API key in your account settings. The **Pro plan** is more than enough for personal use — you don't need anything higher unless you're translating at industrial scale.

Optional:

- An **OpenAI** key from <https://platform.openai.com/api-keys> if you want to use GPT models.
- An **Anthropic** key from <https://console.anthropic.com> if you want to use Claude.
- An **NVIDIA GPU** with the [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) installed if you want to run local Ollama models with GPU acceleration.

---

## Setup

Three convenience scripts cover the three common setups. They each create `.env` from `.env.example` if missing and fill in a random `AES_KEY` for you.

### Linux (CPU-only)

```bash
./setup.sh
```

Brings up the app and a dockerised Ollama, both CPU.

### Linux with NVIDIA GPU

```bash
./setup-with-gpu.sh
```

Same as above, but Ollama gets GPU passthrough. Requires `nvidia-container-toolkit` on the host.

### macOS (Apple Silicon or Intel)

```bash
./macos-setup.sh
```

Installs Ollama natively via Homebrew (so it can use Metal — Docker Desktop on macOS can't pass through the GPU), starts it as a background service, then brings up the app container pointed at the native Ollama. No terminal needs to stay open.

### Manual setup

If you'd rather not use the scripts:

1. Copy `.env.example` to `.env` and fill in:
   - `AES_KEY` — 64 hex chars (`openssl rand -hex 32`). Required for the encrypted secrets table.
   - `TRANSLATION_ROOT_DIR` — host path to your media library. The container mounts this at the same path.
   - `THEMOVIEDB_API_KEY`, `OLLAMA_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — whichever services you want to use. All optional; missing keys just disable that provider.
2. `docker compose up -d --build` (Linux) or `docker compose -f docker-compose.macos.yml up -d --build` (macOS, with native Ollama already running).
3. Browse <http://localhost:4850>. The first-run wizard walks you through admin account creation, model install, and role assignment.

### Updating

```bash
git pull
docker compose up -d --build
```

The schema is allowed to change in alpha. If something refuses to start after an update, blow away the volumes and start fresh:

```bash
docker compose down -v
./setup.sh   # (or the macOS / GPU variant)
```

## Planned future features

This project is built in my free time, so updates depend on how busy I am. That said, here's what's on the roadmap:

### Rewrite to use Bun

Planning to rewrite the entire codebase to use **Bun** instead of Node.js for faster startup, better performance, and simplified tooling.

### Additional subtitle format support

Currently only `.srt` files are supported since it was the easiest format to replicate. Planning to add:

- `.ass` / `.ssa` (Advanced SubStation Alpha)
- `.sup` (Blu-ray subtitles)
- `.idx` (VobSub)
- Other common subtitle formats

### Manual subtitle creation

For media files that have no existing subtitles, I'm planning to add the ability to generate subtitles from scratch based on speech-to-text transcription. This would let you create subtitles for content that has none available.

### API access

Right now all interaction happens through the web dashboard. A future update will add API key support so you can automate subtitle translation without touching the UI — useful for scripting or integrating with other tools.

---

## Configuration notes

### App language (`APP_DEFAULT_LANGUAGE`)

The application supports running the UI in multiple languages. Set `APP_DEFAULT_LANGUAGE` in your `.env` file to change the default interface language (defaults to `en` for English).

All translations were created with **Gemma 4**. You can also change the language per user from within the app settings after logging in.

The environment variable is already configured in `.env.example` and is read by the setup scripts (`setup.sh`, `setup-with-gpu.sh`, `macos-setup.sh`) during initialization.

---

## Recommended setup for best performance

For the best balance of translation quality and speed, I recommend:

1. **Get an Ollama Pro subscription** — just for the cloud models; more than enough for personal use
2. Use **`gemma4:31b-cloud`** for translation and judge tasks
3. Run **`granite4.1:3b`** locally for name formatting (`ollama pull granite4.1:3b`)

This setup gives you high-quality translations from the large cloud model while keeping lightweight tasks like name formatting fast and free by running them locally.

## Support me

If this saves you from hand-translating subtitles for your partner / family / film club, and you'd like to chip in toward keeping it maintained, [details coming soon — sponsor link / Ko-fi / etc to be added here].

In the meantime the best support is:

- Star the repo so it's easier for others to find.
- File issues with reproduction steps when something breaks.
- Share which translation prompts work well for your language pair so I can fold them into the defaults.
