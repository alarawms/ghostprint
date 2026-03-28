# 👻 ghostprint

> Depersonalize your LLM usage. Introduce noise. Prevent fingerprinting.

**ghostprint** sends randomized, low-cost queries to LLM providers on a schedule to contaminate usage profiles and prevent behavioral fingerprinting.

## Why

LLM providers build profiles from your query patterns — topics, timing, phrasing, cadence. ghostprint disrupts this by injecting synthetic noise that looks organic, making it impossible to isolate your real usage fingerprint.

## Features

- 🔌 **Provider-agnostic** — works with any OpenAI-compatible API (Anthropic, OpenAI, Z.ai, Mistral, Cohere, etc.)
- 🎲 **Randomized timing** — irregular intervals with configurable jitter
- 💬 **Organic topics** — 50+ everyday questions that look like real usage
- 💸 **Ultra-cheap** — configurable max tokens, defaults to 60 (< $0.02/month)
- 🔄 **Rotation strategies** — random, round-robin, or weighted across providers
- 📊 **Log & stats** — track runs, costs, and provider distribution
- ⚙️ **Zero dependencies** — pure Python 3, stdlib only

## Quick Start

```bash
# 1. Copy config
cp config.example.yaml config.yaml

# 2. Add your providers
nano config.yaml

# 3. Test run
python3 ghostprint.py --run-once

# 4. Install cron (runs every ~2 hours with jitter)
python3 ghostprint.py --install-cron
```

## Config

```yaml
# config.yaml
providers:
  - name: anthropic
    base_url: https://api.anthropic.com/v1
    api_key: ${ANTHROPIC_API_KEY}
    model: claude-haiku-4-5
    style: anthropic          # anthropic | openai
    weight: 1                 # relative frequency

  - name: zai
    base_url: https://api.z.ai/api/paas/v4
    api_key: ${ZAI_API_KEY}
    model: glm-4-flash
    style: openai
    weight: 1

noise:
  max_tokens: 60              # keep it cheap
  topics_file: topics.txt     # optional custom topics
  strategy: random            # random | round-robin | weighted

schedule:
  base_interval_minutes: 120  # base interval
  jitter_minutes: 40          # ±jitter (so 80–160 min between runs)
```

## Adding Providers

Any OpenAI-compatible endpoint works:

```yaml
- name: openai
  base_url: https://api.openai.com/v1
  api_key: ${OPENAI_API_KEY}
  model: gpt-4o-mini
  style: openai
  weight: 2   # fires twice as often

- name: mistral
  base_url: https://api.mistral.ai/v1
  api_key: ${MISTRAL_API_KEY}
  model: mistral-small-latest
  style: openai
```

## Privacy Philosophy

ghostprint does not store your real queries. It only generates synthetic noise.
The goal is not to hide your identity — it's to make profiling unreliable by
polluting the signal with enough organic-looking noise that no useful fingerprint
can be extracted.

## License

MIT
