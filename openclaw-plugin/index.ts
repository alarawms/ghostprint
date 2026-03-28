/**
 * Ghostprint — OpenClaw Plugin
 * Depersonalizes LLM usage by injecting randomized noise queries
 * across configured providers on a schedule.
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
    const data = JSON.stringify(body);
    const lib = parsed.protocol === "https:" ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    };
    const req = lib.request(opts, res => {
      let out = "";
      res.on("data", chunk => out += chunk);
      res.on("end", () => res.statusCode && res.statusCode < 400 ? resolve(out) : reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`)));
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Provider fire ────────────────────────────────────────────────────────────

interface ProviderCfg {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  style?: string;
  weight?: number;
}

async function fireProvider(p: ProviderCfg, prompt: string, maxTokens: number): Promise<string> {
  const style = p.style ?? "openai";
  const base  = p.base_url.replace(/\/$/, "");

  if (style === "anthropic") {
    const raw = await post(`${base}/messages`, {
      "x-api-key": p.api_key,
      "anthropic-version": "2023-06-01",
    }, { model: p.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
    const d = JSON.parse(raw);
    return d?.content?.[0]?.text ?? "(no reply)";
  } else {
    const raw = await post(`${base}/chat/completions`, {
      "Authorization": `Bearer ${p.api_key}`,
    }, { model: p.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
    const d = JSON.parse(raw);
    return d?.choices?.[0]?.message?.content ?? "(no reply)";
  }
}

// ── Log ──────────────────────────────────────────────────────────────────────

const LOG_PATH = path.join(process.env.HOME ?? "/tmp", ".openclaw", "ghostprint.log");

function logLine(msg: string) {
  const ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// ── Run a noise round ────────────────────────────────────────────────────────

interface RunResult {
  fired: number;
  errors: string[];
  lines: string[];
}

async function runNoise(providers: ProviderCfg[], strategy: string, maxTokens: number): Promise<RunResult> {
  if (!providers.length) return { fired: 0, errors: ["No providers configured"], lines: [] };

  let selected: ProviderCfg[];
  if (strategy === "round-robin") {
    const rrFile = path.join(process.env.HOME ?? "/tmp", ".openclaw", ".ghostprint-rr.json");
    let idx = 0;
    try { idx = JSON.parse(fs.readFileSync(rrFile, "utf8")).idx ?? 0; } catch {}
    selected = [providers[idx % providers.length]];
    try { fs.writeFileSync(rrFile, JSON.stringify({ idx: (idx + 1) % providers.length })); } catch {}
  } else if (strategy === "weighted") {
    const weights = providers.map(p => Math.max(p.weight ?? 1, 1));
    const total   = weights.reduce((a, b) => a + b, 0);
    const k       = Math.random() < 0.5 ? 1 : Math.min(2, providers.length);
    const chosen  = new Set<ProviderCfg>();
    while (chosen.size < k) {
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

  const result: RunResult = { fired: 0, errors: [], lines: [] };

  for (let i = 0; i < selected.length; i++) {
    const p      = selected[i];
    const prompt = pick(TOPICS);
    const line   = `  → ${p.name} | ${p.model} | "${prompt.slice(0, 50)}..."`;
    result.lines.push(line);
    logLine(line);

    try {
      const reply = await fireProvider(p, prompt, maxTokens);
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
  const cfg          = api.config?.plugins?.entries?.ghostprint?.config ?? {};
  const enabled      = cfg.enabled !== false;
  const providers    = (cfg.providers ?? []) as ProviderCfg[];
  const maxTokens    = cfg.max_tokens    ?? 60;
  const strategy     = cfg.strategy     ?? "random";
  const intervalMin  = cfg.interval_minutes ?? 120;
  const jitterMin    = cfg.jitter_minutes   ?? 40;

  // ── Tool: ghostprint_fire ──────────────────────────────────────────────────
  api.registerTool({
    name: "ghostprint_fire",
    description: "Fire a noise round immediately — sends 1-2 random queries to the configured LLM providers to introduce usage noise.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: {}) {
      if (!enabled) {
        return { content: [{ type: "text", text: "ghostprint is disabled. Enable it in plugins config." }] };
      }
      if (!providers.length) {
        return { content: [{ type: "text", text: "No providers configured. Add providers to plugins.entries.ghostprint.config." }] };
      }
      logLine("👻 manual fire");
      const res = await runNoise(providers, strategy, maxTokens);
      const summary = [
        `👻 Ghostprint fired`,
        `Providers hit: ${res.fired}`,
        ...res.lines,
      ].join("\n");
      return { content: [{ type: "text", text: summary }] };
    },
  });

  // ── Tool: ghostprint_stats ─────────────────────────────────────────────────
  api.registerTool({
    name: "ghostprint_stats",
    description: "Show ghostprint run history and stats from the log.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: {}) {
      try {
        const lines  = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
        const manual = lines.filter(l => l.includes("manual fire")).length;
        const sched  = lines.filter(l => l.includes("scheduled fire")).length;
        const ok     = lines.filter(l => l.includes("✓")).length;
        const fail   = lines.filter(l => l.includes("✗")).length;
        const recent = lines.slice(-10).join("\n");
        const txt    = [
          `📊 Ghostprint stats`,
          `Manual runs : ${manual}`,
          `Scheduled   : ${sched}`,
          `Successful  : ${ok}`,
          `Failed      : ${fail}`,
          ``,
          `Last 10 log entries:`,
          recent,
        ].join("\n");
        return { content: [{ type: "text", text: txt }] };
      } catch {
        return { content: [{ type: "text", text: "No log yet. Run ghostprint_fire to start." }] };
      }
    },
  });

  // ── Background service: scheduled noise ───────────────────────────────────
  if (enabled && providers.length > 0) {
    api.logger.info(`[ghostprint] Starting scheduler — every ${intervalMin}min ±${jitterMin}min jitter`);

    const schedule = () => {
      const jitter = Math.floor(Math.random() * jitterMin * 60 * 1000);
      const wait   = intervalMin * 60 * 1000 + jitter;
      setTimeout(async () => {
        logLine("👻 scheduled fire");
        try {
          await runNoise(providers, strategy, maxTokens);
        } catch (e: any) {
          logLine(`  ✗ scheduler error: ${e.message}`);
        }
        schedule(); // re-arm
      }, wait);
    };

    schedule();
  } else if (enabled && !providers.length) {
    api.logger.warn("[ghostprint] No providers configured — scheduler not started. Add providers in plugins config.");
  }

  api.logger.info("[ghostprint] Ghostprint loaded — tools: ghostprint_fire, ghostprint_stats");
}
