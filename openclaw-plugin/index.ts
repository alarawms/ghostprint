/**
 * Ghostprint — OpenClaw Plugin
 * Depersonalizes LLM usage by injecting randomized noise queries
 * across configured providers on a schedule.
 *
 * Resolves API keys from OpenClaw's existing provider credentials —
 * no separate key config required.
 *
 * Registers:
 *   - Tool: `ghostprint_fire`  — fire noise manually on demand
 *   - Tool: `ghostprint_stats` — show run history from log
 *   - Background service: scheduled noise on interval + jitter
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";

// ── Built-in topics ──────────────────────────────────────────────────────────

const TOPICS = [
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
  "How do I unclog a slow drain?",
  "Why do leaves change color in autumn?",
  "What causes muscle cramps?",
  "How do I sharpen kitchen knives at home?",
  "Why does popcorn pop?",
  "What causes food cravings?",
  "Why do we get brain freeze from cold food?",
  "How do I stop cut apples from going brown?",
  "How do I make rice not stick to the pot?",
];

// ── Default provider definitions (OpenClaw-native) ───────────────────────────

const DEFAULT_PROVIDERS = [
  {
    name:     "anthropic",
    provider: "anthropic",               // used with resolveApiKeyForProvider
    base_url: "https://api.anthropic.com/v1",
    model:    "claude-haiku-4-5",
    style:    "anthropic" as const,
    weight:   1,
  },
  {
    name:     "zai",
    provider: "zai",
    base_url: "https://api.z.ai/api/paas/v4",
    model:    "glm-4-flash",
    style:    "openai" as const,
    weight:   1,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sample<T>(arr: T[], k: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(k, copy.length));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function post(urlStr: string, headers: Record<string, string>, body: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const data   = JSON.stringify(body);
    const lib    = parsed.protocol === "https:" ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = lib.request(opts, res => {
      let out = "";
      res.on("data", chunk => out += chunk);
      res.on("end", () =>
        res.statusCode && res.statusCode < 400
          ? resolve(out)
          : reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`)),
      );
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Log ──────────────────────────────────────────────────────────────────────

const LOG_PATH = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "ghostprint.log",
);

function logLine(msg: string) {
  const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// ── Fire a single provider ───────────────────────────────────────────────────

interface ProviderEntry {
  name: string;
  provider: string;
  base_url: string;
  model: string;
  style: "anthropic" | "openai";
  weight: number;
  api_key?: string; // resolved at call time
}

async function fireOne(p: ProviderEntry, apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const base = p.base_url.replace(/\/$/, "");

  if (p.style === "anthropic") {
    const raw = await post(`${base}/messages`, {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }, {
      model: p.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const d = JSON.parse(raw);
    return d?.content?.[0]?.text ?? "(no reply)";
  } else {
    const raw = await post(`${base}/chat/completions`, {
      "Authorization": `Bearer ${apiKey}`,
    }, {
      model: p.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const d = JSON.parse(raw);
    return d?.choices?.[0]?.message?.content ?? "(no reply)";
  }
}

// ── Run a noise round ────────────────────────────────────────────────────────

interface RunResult {
  fired: number;
  skipped: number;
  errors: string[];
  lines: string[];
}

async function runNoise(
  providers: ProviderEntry[],
  strategy: string,
  maxTokens: number,
  resolveKey: (provider: string) => Promise<string | undefined>,
): Promise<RunResult> {
  const result: RunResult = { fired: 0, skipped: 0, errors: [], lines: [] };

  if (!providers.length) {
    result.errors.push("No providers configured");
    return result;
  }

  // Select which providers to fire this round
  let selected: ProviderEntry[];
  const rrFile = path.join(process.env.HOME ?? "/tmp", ".openclaw", ".ghostprint-rr.json");

  if (strategy === "round-robin") {
    let idx = 0;
    try { idx = JSON.parse(fs.readFileSync(rrFile, "utf8")).idx ?? 0; } catch {}
    selected = [providers[idx % providers.length]];
    try { fs.writeFileSync(rrFile, JSON.stringify({ idx: (idx + 1) % providers.length })); } catch {}
  } else if (strategy === "weighted") {
    const weights = providers.map(p => Math.max(p.weight ?? 1, 1));
    const total   = weights.reduce((a, b) => a + b, 0);
    const k       = Math.random() < 0.5 ? 1 : Math.min(2, providers.length);
    const chosen  = new Set<ProviderEntry>();
    let attempts  = 0;
    while (chosen.size < k && attempts++ < 20) {
      let r = Math.random() * total, acc = 0;
      for (let i = 0; i < providers.length; i++) {
        acc += weights[i];
        if (r <= acc) { chosen.add(providers[i]); break; }
      }
    }
    selected = [...chosen];
  } else {
    const k = Math.random() < 0.6 ? 1 : Math.min(2, providers.length);
    selected = sample(providers, k);
  }

  for (let i = 0; i < selected.length; i++) {
    const p   = selected[i];
    const key = await resolveKey(p.provider);

    if (!key) {
      const msg = `  ⚠️  ${p.name}: no API key available (not configured in OpenClaw) — skipping`;
      result.lines.push(msg);
      logLine(msg);
      result.skipped++;
      continue;
    }

    const prompt = pick(TOPICS);
    const line   = `  → ${p.name} | ${p.model} | "${prompt.slice(0, 50)}..."`;
    result.lines.push(line);
    logLine(line);

    try {
      const reply = await fireOne(p, key, prompt, maxTokens);
      const ok    = `  ✓ ${p.name}: "${reply.slice(0, 70)}"`;
      result.lines.push(ok);
      logLine(ok);
      result.fired++;
    } catch (e: any) {
      const err = `  ✗ ${p.name}: ${e.message}`;
      result.lines.push(err);
      logLine(err);
      result.errors.push(err);
    }

    if (i < selected.length - 1) await sleep(1000 + Math.random() * 4000);
  }

  return result;
}

// ── Plugin entry ─────────────────────────────────────────────────────────────

export default function (api: any) {
  const cfg        = api.config?.plugins?.entries?.ghostprint?.config ?? {};
  const enabled    = cfg.enabled !== false;
  const maxTokens  = cfg.max_tokens      ?? 60;
  const strategy   = cfg.strategy        ?? "random";
  const intervalMin = cfg.interval_minutes ?? 120;
  const jitterMin   = cfg.jitter_minutes   ?? 40;

  // Providers: use config overrides if present, otherwise default to anthropic + zai
  const providers: ProviderEntry[] = cfg.providers?.length
    ? cfg.providers
    : DEFAULT_PROVIDERS;

  // Key resolver: uses OpenClaw's existing provider credentials via api.runtime
  const resolveKey = async (provider: string): Promise<string | undefined> => {
    try {
      const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
        provider,
        cfg: api.config,
      });
      return auth?.apiKey ?? undefined;
    } catch {
      return undefined;
    }
  };

  // ── Tool: ghostprint_fire ────────────────────────────────────────────────
  api.registerTool({
    name: "ghostprint_fire",
    description: "Fire a ghostprint noise round immediately — sends 1–2 random everyday questions to your configured LLM providers to depersonalize your usage profile.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: {}) {
      if (!enabled) {
        return { content: [{ type: "text", text: "ghostprint is disabled in config." }] };
      }
      logLine("👻 manual fire");
      const res = await runNoise(providers, strategy, maxTokens, resolveKey);
      const summary = [
        `👻 Ghostprint — noise round complete`,
        `Fired: ${res.fired} | Skipped: ${res.skipped} | Errors: ${res.errors.length}`,
        ...res.lines,
      ].join("\n");
      return { content: [{ type: "text", text: summary }] };
    },
  });

  // ── Tool: ghostprint_stats ───────────────────────────────────────────────
  api.registerTool({
    name: "ghostprint_stats",
    description: "Show ghostprint run history and cumulative stats from the log file.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: {}) {
      try {
        const lines  = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
        const manual = lines.filter(l => l.includes("manual fire")).length;
        const sched  = lines.filter(l => l.includes("scheduled fire")).length;
        const ok     = lines.filter(l => l.includes("✓")).length;
        const fail   = lines.filter(l => l.includes("✗")).length;
        const skip   = lines.filter(l => l.includes("⚠️")).length;
        const recent = lines.slice(-10).join("\n");
        const txt = [
          `📊 Ghostprint stats`,
          `Manual runs  : ${manual}`,
          `Scheduled    : ${sched}`,
          `Successful   : ${ok}`,
          `Failed       : ${fail}`,
          `Skipped      : ${skip}`,
          ``,
          `Last 10 log lines:`,
          recent,
        ].join("\n");
        return { content: [{ type: "text", text: txt }] };
      } catch {
        return { content: [{ type: "text", text: "No log yet. Run ghostprint_fire to start." }] };
      }
    },
  });

  // ── Background scheduler ─────────────────────────────────────────────────
  if (enabled) {
    api.logger.info(`[ghostprint] Scheduler armed — every ${intervalMin}min ±${jitterMin}min jitter`);

    const schedule = () => {
      const jitterMs = Math.floor(Math.random() * jitterMin * 60 * 1000);
      const waitMs   = intervalMin * 60 * 1000 + jitterMs;
      setTimeout(async () => {
        logLine("👻 scheduled fire");
        try {
          await runNoise(providers, strategy, maxTokens, resolveKey);
        } catch (e: any) {
          logLine(`  ✗ scheduler error: ${e.message}`);
        }
        schedule(); // re-arm for next round
      }, waitMs);
    };

    schedule();
  }

  api.logger.info("[ghostprint] Loaded — tools: ghostprint_fire, ghostprint_stats");
}
