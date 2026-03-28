#!/usr/bin/env python3
"""
ghostprint — LLM fingerprint noise injector
Provider-agnostic, zero-dependency, schedule-aware.

Usage:
    python3 ghostprint.py               # run with jitter (cron mode)
    python3 ghostprint.py --run-once    # fire immediately, no jitter
    python3 ghostprint.py --install-cron
    python3 ghostprint.py --stats
"""

import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────

BASE_DIR    = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.yaml"
LOG_FILE    = BASE_DIR / "ghostprint.log"
TOPICS_FILE = BASE_DIR / "topics.txt"

# ── Built-in topics (used if topics.txt absent) ───────────────────────────────

BUILTIN_TOPICS = [
    "What's the best way to store fresh herbs?",
    "How do I remove a stripped screw?",
    "What causes hiccups?",
    "How long does pasta dough last in the fridge?",
    "What's the difference between a virus and bacteria?",
    "Why does the sky turn red at sunset?",
    "How do I clean a cast iron pan?",
    "What's a good substitute for buttermilk in baking?",
    "Why do cats purr?",
    "How do I fix a squeaky door hinge?",
    "What's the best way to remove a wine stain?",
    "How long should I steep green tea?",
    "What causes déjà vu?",
    "How do you fold a fitted sheet neatly?",
    "Why does bread go stale?",
    "What's the difference between jam and jelly?",
    "How do I get rid of fruit flies in the kitchen?",
    "What causes static electricity?",
    "How do I soften hard brown sugar?",
    "What's the fastest way to cool down a hot drink?",
    "Why do onions make you cry?",
    "How do I descale an electric kettle?",
    "What's the best way to ripen an avocado quickly?",
    "How do I stop a minor nosebleed?",
    "Why does metal feel colder than wood at room temperature?",
    "How do I keep cut flowers fresh longer?",
    "What's the difference between baking soda and baking powder?",
    "How do I get rid of a headache without medication?",
    "What causes thunder?",
    "How do I make my coffee less bitter?",
    "How do I keep bananas from turning brown?",
    "What's the difference between perfume and eau de toilette?",
    "How do I unclog a slow drain?",
    "Why do leaves change color in autumn?",
    "How do I get wax out of a candle holder?",
    "What causes muscle cramps?",
    "How do I keep lettuce crisp in the fridge?",
    "What's the best way to clean a wooden cutting board?",
    "How do I sharpen kitchen knives at home?",
    "Why does popcorn pop?",
    "How do I remove a splinter safely?",
    "What causes food cravings?",
    "How do I fix a running toilet?",
    "What's the best way to fold a t-shirt to save space?",
    "Why do we get brain freeze from cold food?",
    "How do I stop cut apples from going brown?",
    "What's the difference between a cold and the flu?",
    "How do I get rid of condensation on windows?",
    "Why does hot water sometimes freeze faster than cold?",
    "How do I make rice not stick to the pot?",
]


# ── Minimal YAML parser (no deps) ────────────────────────────────────────────

def parse_yaml(text: str) -> dict:
    """
    Parse a minimal subset of YAML sufficient for our config.
    Handles: strings, numbers, booleans, nested mappings, lists of mappings.
    Expands ${ENV_VAR} references.
    """
    def resolve(val: str) -> str:
        return re.sub(r'\$\{(\w+)\}', lambda m: os.environ.get(m.group(1), ''), val)

    lines = text.splitlines()
    # We'll build the structure with a simple stack-based approach
    # Returns a dict for top-level keys

    def parse_value(s: str):
        s = s.strip()
        if s.lower() == 'true': return True
        if s.lower() == 'false': return False
        try: return int(s)
        except ValueError: pass
        try: return float(s)
        except ValueError: pass
        return resolve(s.strip('"').strip("'"))

    root = {}
    stack = [(0, root)]  # (indent, container)
    list_stack = []      # track list contexts

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()
        if not stripped or stripped.lstrip().startswith('#'):
            i += 1
            continue

        indent = len(line) - len(line.lstrip())
        content = line.strip()

        # List item
        if content.startswith('- '):
            item_str = content[2:]
            # Find or create list at current indent
            # pop stack to match indent
            while len(stack) > 1 and stack[-1][0] >= indent:
                stack.pop()
            parent_container = stack[-1][1]

            if item_str and ':' not in item_str:
                # simple list item
                pass  # not needed for our config

            # It's a list of dicts — collect subsequent indented keys
            obj = {}
            list_key = None
            # find the key this list belongs to
            for k, v in reversed(list(parent_container.items())):
                if isinstance(v, list):
                    list_key = k
                    parent_container[k].append(obj)
                    break
            if list_key is None:
                # shouldn't happen in well-formed config
                pass

            # parse inline k:v if any
            if item_str and ':' in item_str:
                k2, _, v2 = item_str.partition(':')
                obj[k2.strip()] = parse_value(v2)

            stack.append((indent + 2, obj))
            i += 1
            continue

        # Key: value
        if ':' in content:
            key, _, val = content.partition(':')
            key = key.strip()
            val = val.strip()

            # pop stack to appropriate level
            while len(stack) > 1 and stack[-1][0] >= indent:
                stack.pop()
            container = stack[-1][1]

            if val == '' or val.startswith('#'):
                # check next line to determine if mapping or list
                next_line = lines[i+1].strip() if i+1 < len(lines) else ''
                if next_line.startswith('- '):
                    container[key] = []
                    stack.append((indent + 2, container[key]))
                else:
                    container[key] = {}
                    stack.append((indent + 2, container[key]))
            else:
                if '#' in val:
                    val = val[:val.index('#')].strip()
                container[key] = parse_value(val)

        i += 1

    return root


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        # Return a minimal default (no providers)
        return {"providers": [], "noise": {}, "schedule": {}}
    return parse_yaml(CONFIG_FILE.read_text())


def load_topics(cfg: dict) -> list:
    tf = cfg.get("noise", {}).get("topics_file")
    if tf:
        p = BASE_DIR / tf
        if p.exists():
            return [l.strip() for l in p.read_text().splitlines() if l.strip()]
    if TOPICS_FILE.exists():
        return [l.strip() for l in TOPICS_FILE.read_text().splitlines() if l.strip()]
    return BUILTIN_TOPICS


# ── Logging ───────────────────────────────────────────────────────────────────

def log(msg: str, also_print: bool = True):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    if also_print:
        print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _post(url: str, headers: dict, payload: dict, timeout: int = 25) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fire_anthropic(provider: dict, prompt: str, max_tokens: int) -> str:
    data = _post(
        url=provider["base_url"].rstrip("/") + "/messages",
        headers={
            "x-api-key": provider["api_key"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        payload={
            "model": provider["model"],
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    return data["content"][0]["text"]


def fire_openai(provider: dict, prompt: str, max_tokens: int) -> str:
    data = _post(
        url=provider["base_url"].rstrip("/") + "/chat/completions",
        headers={
            "Authorization": f"Bearer {provider['api_key']}",
            "Content-Type": "application/json",
        },
        payload={
            "model": provider["model"],
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    return data["choices"][0]["message"]["content"]


DISPATCH = {
    "anthropic": fire_anthropic,
    "openai":    fire_openai,
}


def fire_provider(provider: dict, prompt: str, max_tokens: int) -> bool:
    name  = provider.get("name", "unknown")
    style = provider.get("style", "openai")
    key   = provider.get("api_key", "")

    if not key:
        log(f"  ⚠️  {name}: no api_key — skipping")
        return False

    log(f'  → {name} | {provider["model"]} | "{prompt[:55]}..."')

    fn = DISPATCH.get(style)
    if fn is None:
        log(f"  ✗ {name}: unknown style '{style}'")
        return False

    try:
        reply = fn(provider, prompt, max_tokens)
        log(f'  ✓ {name}: "{reply[:70]}"')
        return True
    except urllib.error.HTTPError as e:
        log(f"  ✗ {name}: HTTP {e.code} {e.reason}")
    except Exception as e:
        log(f"  ✗ {name}: {e}")
    return False


# ── Provider selection strategies ────────────────────────────────────────────

def select_providers(providers: list, strategy: str) -> list:
    if not providers:
        return []

    if strategy == "round-robin":
        state_file = BASE_DIR / ".rr_state.json"
        idx = 0
        if state_file.exists():
            try: idx = json.loads(state_file.read_text()).get("idx", 0)
            except Exception: pass
        selected = [providers[idx % len(providers)]]
        state_file.write_text(json.dumps({"idx": (idx + 1) % len(providers)}))
        return selected

    if strategy == "weighted":
        weights = [max(p.get("weight", 1), 1) for p in providers]
        # pick 1-2 based on weights
        k = random.randint(1, min(2, len(providers)))
        chosen = random.choices(providers, weights=weights, k=k)
        # deduplicate preserving order
        seen = set(); result = []
        for p in chosen:
            pid = id(p)
            if pid not in seen:
                seen.add(pid); result.append(p)
        return result

    # default: random
    k = random.randint(1, min(2, len(providers)))
    return random.sample(providers, k=k)


# ── Stats ─────────────────────────────────────────────────────────────────────

def show_stats():
    if not LOG_FILE.exists():
        print("No log file yet.")
        return

    lines = LOG_FILE.read_text().splitlines()
    runs = sum(1 for l in lines if "run started" in l)
    ok   = sum(1 for l in lines if "✓" in l)
    fail = sum(1 for l in lines if "✗" in l)
    print(f"Total runs  : {runs}")
    print(f"Successful  : {ok}")
    print(f"Failed      : {fail}")
    if lines:
        print(f"First entry : {lines[0][:30]}")
        print(f"Last entry  : {lines[-1][:30]}")


# ── Cron install ──────────────────────────────────────────────────────────────

def install_cron(cfg: dict):
    schedule = cfg.get("schedule", {})
    base = schedule.get("base_interval_minutes", 120)

    script = Path(__file__).resolve()
    cron_line = f"*/{base} * * * * python3 {script} 2>> {LOG_FILE}\n"

    import subprocess
    result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    existing = result.stdout if result.returncode == 0 else ""

    if str(script) in existing:
        print("ghostprint is already in crontab.")
        return

    new_cron = existing + cron_line
    proc = subprocess.run(["crontab", "-"], input=new_cron, text=True)
    if proc.returncode == 0:
        print(f"✅ Cron installed: every {base} min + jitter")
        print(f"   {cron_line.strip()}")
    else:
        print("❌ Failed to install cron. Add manually:")
        print(f"   {cron_line.strip()}")


# ── Main ──────────────────────────────────────────────────────────────────────

def run(cfg: dict, immediate: bool = False):
    log("👻 ghostprint — run started")

    schedule = cfg.get("schedule", {})
    noise_cfg = cfg.get("noise", {})

    # Apply jitter unless immediate
    if not immediate:
        jitter_min = schedule.get("jitter_minutes", 20)
        sleep_secs = random.randint(0, jitter_min * 60)
        log(f"  ⏱  jitter: sleeping {sleep_secs // 60}m {sleep_secs % 60}s")
        time.sleep(sleep_secs)

    providers = cfg.get("providers", [])
    if not providers:
        log("  ⚠️  no providers configured — edit config.yaml")
        return

    strategy  = noise_cfg.get("strategy", "random")
    max_tokens = noise_cfg.get("max_tokens", 60)
    topics    = load_topics(cfg)

    selected = select_providers(providers, strategy)
    log(f"  strategy={strategy} | firing {len(selected)} provider(s)")

    for p in selected:
        prompt = random.choice(topics)
        fire_provider(p, prompt, max_tokens)
        if len(selected) > 1:
            time.sleep(random.uniform(1, 5))

    log("✅ done\n")


def main():
    parser = argparse.ArgumentParser(description="ghostprint — LLM noise injector")
    parser.add_argument("--run-once",      action="store_true", help="Fire immediately, no jitter")
    parser.add_argument("--install-cron",  action="store_true", help="Install to crontab")
    parser.add_argument("--stats",         action="store_true", help="Show stats from log")
    args = parser.parse_args()

    cfg = load_config()

    if args.stats:
        show_stats(); return
    if args.install_cron:
        install_cron(cfg); return

    run(cfg, immediate=args.run_once)


if __name__ == "__main__":
    main()
