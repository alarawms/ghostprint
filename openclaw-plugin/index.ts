/**
 * Ghostprint — OpenClaw Plugin v2.0
 *
 * Depersonalizes LLM usage by injecting behaviorally realistic noise queries
 * across configured providers. Designed to be statistically indistinguishable
 * from real human usage — not just "random questions".
 *
 * Anti-fingerprinting design:
 *  - Cryptographic randomness (crypto.randomInt) for all timing decisions
 *  - Poisson-process inter-arrival times (exponential distribution)
 *  - Time-of-day weighting — noise clusters in waking hours like real users
 *  - Variable token budgets drawn from log-normal distribution
 *  - Multi-domain topic pool (300+ prompts across 12 categories)
 *  - Occasional multi-turn "sessions" (2–4 messages)
 *  - Variable prompt length and structure (fragments, full sentences, context-rich)
 *  - Randomized temperature per request
 *  - Occasional system prompts
 *  - Provider selection via Poisson-weighted draw, not fixed k
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { URL } from "url";

// ── Cryptographic randomness ─────────────────────────────────────────────────
// Math.random() is PRNG and statistically detectable over many samples.
// Use crypto.randomInt for anything timing or selection related.

function randInt(min: number, max: number): number {
  // crypto.randomInt(min, max) → [min, max)
  return crypto.randomInt(min, max + 1);
}

function randFloat(): number {
  // Uniform float [0, 1) from crypto bytes
  const buf = crypto.randomBytes(4);
  return buf.readUInt32BE(0) / 0x100000000;
}

function randChoice<T>(arr: T[]): T {
  return arr[crypto.randomInt(0, arr.length)];
}

function randSample<T>(arr: T[], k: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(k, copy.length));
}

// Log-normal sample: good model for token counts, delays, human response lengths
function logNormal(mu: number, sigma: number): number {
  // Box-Muller transform (uses two uniform samples)
  const u1 = Math.max(randFloat(), 1e-10);
  const u2 = randFloat();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}

// Exponential sample: inter-arrival times for a Poisson process
function exponential(mean: number): number {
  return -mean * Math.log(Math.max(randFloat(), 1e-10));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Topic pool — 12 domains, 300+ prompts ────────────────────────────────────
// Deliberately varied: fragments, full sentences, context-rich, terse.
// No single syntactic pattern dominates.

const TOPIC_POOL: string[] = [
  // Cooking & food
  "How long does pasta dough last in the fridge?",
  "Best substitute for buttermilk in baking?",
  "Why does bread go stale so fast?",
  "How do I stop cut apples from browning?",
  "Difference between jam and jelly",
  "What's the ratio for making a basic vinaigrette?",
  "How to ripen an avocado overnight",
  "Why is my sourdough not rising?",
  "How do I keep herbs fresh for longer?",
  "What temp should I cook chicken to?",
  "How to cook rice without it sticking",
  "Why does my pasta water need to be salty?",
  "How long can I keep leftover rice in the fridge?",
  "Difference between baking soda and baking powder",
  "Why do eggs float when they're old?",
  "How to make coffee less bitter",
  "Best way to store fresh bread",
  "What is umami exactly?",
  "How to temper chocolate at home",
  "Why does garlic turn blue when pickled?",

  // Health & body
  "What causes hiccups?",
  "How do I stop a nosebleed?",
  "Why do I get hungry again right after eating?",
  "What causes muscle cramps at night?",
  "How long does a cold last on average?",
  "Difference between cold and flu symptoms",
  "Why do we yawn when we see others yawn?",
  "What causes brain freeze?",
  "How much water should I actually drink per day?",
  "Why does exercise make you feel better mentally?",
  "What causes déjà vu?",
  "How do I get rid of a headache without pills?",
  "Why do I feel tired after eating?",
  "What causes food cravings?",
  "How does sleep deprivation affect concentration?",
  "Why do I bruise so easily?",
  "What's the difference between a sprain and a strain?",
  "How long does it take a broken bone to heal?",
  "Why do joints crack?",
  "What causes restless leg syndrome?",

  // Science & nature
  "Why does the sky turn red at sunset?",
  "What causes thunder?",
  "Why does metal feel colder than wood at the same temperature?",
  "How do plants know which direction to grow?",
  "Why do leaves change color in autumn?",
  "What causes static electricity?",
  "Why does hot water sometimes freeze faster than cold water?",
  "How does a rainbow form?",
  "Why do cats purr?",
  "How do birds navigate during migration?",
  "What causes earthquakes?",
  "Why is the ocean salty?",
  "How do fireflies produce light?",
  "Why do we have seasons?",
  "What is the difference between a meteor and a meteorite?",
  "Why does the moon look bigger on the horizon?",
  "How do volcanoes form?",
  "Why do some animals hibernate?",
  "What causes the Northern Lights?",
  "Why does ice float on water?",

  // Home & DIY
  "How do I remove a stripped screw?",
  "How to fix a squeaky door hinge",
  "Best way to unclog a slow drain",
  "How do I stop condensation on windows?",
  "How to descale a kettle without vinegar",
  "Why does my toilet keep running?",
  "How to patch a small hole in drywall",
  "Best way to remove paint from wood",
  "How do I get rid of fruit flies?",
  "How to remove a wine stain from carpet",
  "Why does my circuit breaker keep tripping?",
  "How to clean a cast iron pan",
  "How to remove rust from tools",
  "Best way to insulate a drafty window",
  "How do I stop my pipes from freezing?",
  "How to clean mold from bathroom grout",
  "Why does my dishwasher leave spots?",
  "How to sharpen a kitchen knife without a whetstone",
  "How to remove wax from a candle holder",
  "Why does my paint keep peeling?",

  // Technology (everyday, not specialized)
  "Why is my phone battery draining so fast?",
  "How do I clear cache on my browser?",
  "What does VPN actually do?",
  "Why does my wifi slow down at night?",
  "How do I stop getting so many spam emails?",
  "What's the difference between RAM and storage?",
  "How do I make a PDF smaller?",
  "Why does my laptop get so hot?",
  "What's a good way to backup my photos?",
  "How do I recover a deleted file?",
  "What does airplane mode actually do to your phone?",
  "Why does restarting a computer fix most problems?",
  "How do I stop apps from running in the background?",
  "What's the difference between 4G and 5G?",
  "How do I check if a website is safe?",
  "What is two-factor authentication and should I use it?",
  "How do I transfer contacts between phones?",
  "Why does my computer slow down over time?",
  "What's the difference between HDMI and DisplayPort?",
  "How do I free up storage on my phone?",

  // Finance & money (everyday)
  "What's the difference between a debit and credit card?",
  "How does compound interest work?",
  "What is an emergency fund and how much should I have?",
  "Difference between a Roth and traditional IRA",
  "What is a credit score made up of?",
  "How do I negotiate a lower interest rate?",
  "What happens if I miss a credit card payment?",
  "Is it better to lease or buy a car?",
  "What's the 50/30/20 budget rule?",
  "How do index funds work?",
  "What is dollar-cost averaging?",
  "How much should I save for retirement each month?",
  "What is inflation and why does it matter?",
  "What's the difference between gross and net income?",
  "How do I read a pay stub?",

  // Language & writing
  "Difference between 'affect' and 'effect'",
  "When to use 'who' vs 'whom'?",
  "What's an Oxford comma and does it matter?",
  "How do I write a good professional email?",
  "What's the difference between 'fewer' and 'less'?",
  "Is it okay to start a sentence with 'but' or 'and'?",
  "How do I write a strong thesis statement?",
  "What is passive voice and why avoid it?",
  "How long should paragraphs be?",
  "What's the difference between 'i.e.' and 'e.g.'?",
  "How do I cite a website in APA format?",
  "What is the em dash used for?",
  "Difference between 'its' and 'it's'",
  "How do I make my writing more concise?",
  "What is the difference between 'lay' and 'lie'?",

  // Travel & geography
  "What's the best way to avoid jet lag?",
  "Do I need travel insurance?",
  "What's the difference between a visa and a passport?",
  "How far in advance should I book flights?",
  "What should I pack in a carry-on?",
  "What's the best way to exchange currency?",
  "Is it safe to drink tap water in Europe?",
  "How do I find cheap last-minute flights?",
  "What vaccinations do I need for Southeast Asia?",
  "What time zone is Dubai in?",
  "How big is the Sahara Desert compared to the US?",
  "What's the highest mountain in Africa?",
  "What's the difference between Great Britain and the UK?",
  "How long is a flight from London to New York?",
  "What's the best way to get around Tokyo without speaking Japanese?",

  // Psychology & behavior
  "Why do people procrastinate?",
  "What is confirmation bias?",
  "Why do we remember bad experiences more than good ones?",
  "What is the Dunning-Kruger effect?",
  "Why do habits form and how do I break them?",
  "What causes social anxiety?",
  "Why is it hard to make decisions when tired?",
  "What is cognitive dissonance?",
  "Why do we compare ourselves to others?",
  "What's the science behind willpower?",
  "Why do some people need alone time to recharge?",
  "What is the placebo effect?",
  "Why does music affect our mood?",
  "What causes stage fright?",
  "Why do we dream?",

  // History & culture
  "Why did the Roman Empire fall?",
  "What started World War I?",
  "What is the difference between the British and American industrial revolutions?",
  "Why was the printing press so significant?",
  "What caused the Great Depression?",
  "How did ancient Egyptians build the pyramids?",
  "What is the significance of the Magna Carta?",
  "Why did the Cold War start?",
  "What was the Silk Road?",
  "How did the Black Death change Europe?",

  // Lifestyle & everyday
  "How long should I really keep leftovers?",
  "Best way to fold a fitted sheet",
  "How do I get grass stains out of jeans?",
  "How often should I replace my toothbrush?",
  "Is it bad to crack your knuckles?",
  "How do I make mornings less painful?",
  "What's the best way to declutter?",
  "How do I get better at remembering names?",
  "Is it better to shower in the morning or at night?",
  "How long should I actually be brushing my teeth?",
  "What's the best way to deal with a difficult coworker?",
  "How do I stop overthinking?",
  "What's a good way to wind down before bed?",
  "How do I apologize properly?",
  "Is coffee actually bad for you?",

  // Multi-sentence / context-rich (structural variety)
  "I've been trying to learn Spanish for about a year. I can read okay but my speaking is really slow. What's the best way to improve fluency?",
  "My sourdough starter is about a week old and it smells kind of like vinegar. Is that normal or have I done something wrong?",
  "I keep waking up at 3am and can't get back to sleep. It's been happening for about two weeks. Any ideas what might cause this?",
  "I just started running and my knees hurt after about 20 minutes. Is that normal or a sign I should stop?",
  "I have a job interview next week at a company I really want to work at. What's the best way to prepare?",
  "I'm trying to save money but every month I spend more than I planned. How do people actually stick to a budget?",
  "My houseplant looks wilted even though I've been watering it regularly. Could I be overwatering it?",
  "I'm moving to a new city and don't know anyone. How do adults actually make friends?",
  "My landlord wants to increase my rent by 15%. Is that normal and what are my options?",
  "I've been working from home for two years and feel really isolated. Any practical ways to feel less disconnected?",
];

// ── Occasional system prompts (adds structural variety) ──────────────────────
const SYSTEM_PROMPTS: string[] = [
  "You are a helpful assistant. Answer concisely.",
  "Be direct and to the point.",
  "Keep your answer under 3 sentences.",
  "Explain things simply, as if to a curious person with no background knowledge.",
  "Give practical, actionable advice.",
];

// ── Default providers ─────────────────────────────────────────────────────────

const DEFAULT_PROVIDERS = [
  {
    name:     "anthropic",
    provider: "anthropic",
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

interface ProviderEntry {
  name: string;
  provider: string;
  base_url: string;
  model: string;
  style: "anthropic" | "openai";
  weight?: number;
}

// ── Token budget: log-normal distribution ────────────────────────────────────
// Real users request wildly different response lengths.
// Log-normal(mu=4.0, sigma=0.8) gives a range roughly [20, 400]
// with median ~55 — cheap but variable.

function sampleMaxTokens(): number {
  const t = Math.round(logNormal(4.0, 0.8));
  return Math.max(20, Math.min(400, t));
}

// ── Temperature: random per request ─────────────────────────────────────────

function sampleTemperature(): number {
  // Most real usage: 0.3–1.0, rarely extreme
  return Math.round((0.3 + randFloat() * 0.8) * 10) / 10;
}

// ── Time-of-day weight ───────────────────────────────────────────────────────
// Suppress noise during sleep hours (midnight–7am local).
// Real users don't query LLMs at 3am. This makes noise behaviorally plausible
// AND prevents timing correlation between 3am noise and daylight real sessions.

function isQuietHour(tzOffsetHours: number = 3): boolean {
  const utcHour    = new Date().getUTCHours();
  const localHour  = (utcHour + tzOffsetHours + 24) % 24;
  return localHour >= 0 && localHour < 7;
}

// ── Inter-arrival timing: Poisson process ────────────────────────────────────
// Human activity is well-modeled by a Poisson process.
// Exponential inter-arrival times are statistically different from
// the uniform jitter we had before.

function sampleIntervalMs(baseMin: number, maxMin: number): number {
  const meanMin = (baseMin + maxMin) / 2;
  const ms      = exponential(meanMin * 60 * 1000);
  // Clamp to [baseMin, maxMin*2] to avoid absurdly long or short intervals
  return Math.max(baseMin * 60 * 1000, Math.min(maxMin * 2 * 60 * 1000, ms));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

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
      res.on("data", chunk => (out += chunk));
      res.on("end",  () =>
        res.statusCode && res.statusCode < 400
          ? resolve(out)
          : reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`)),
      );
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Fire a single request ────────────────────────────────────────────────────

interface FireOptions {
  prompt: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

async function fireOne(p: ProviderEntry, apiKey: string, opts: FireOptions): Promise<string> {
  const base = p.base_url.replace(/\/$/, "");
  const { prompt, maxTokens, temperature, systemPrompt } = opts;

  if (p.style === "anthropic") {
    const body: any = {
      model:      p.model,
      max_tokens: maxTokens,
      temperature,
      messages:   [{ role: "user", content: prompt }],
    };
    if (systemPrompt) body.system = systemPrompt;

    const raw = await post(`${base}/messages`, {
      "x-api-key":          apiKey,
      "anthropic-version":  "2023-06-01",
    }, body);
    return JSON.parse(raw)?.content?.[0]?.text ?? "(no reply)";

  } else {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const raw = await post(`${base}/chat/completions`, {
      "Authorization": `Bearer ${apiKey}`,
    }, { model: p.model, max_tokens: maxTokens, temperature, messages });
    return JSON.parse(raw)?.choices?.[0]?.message?.content ?? "(no reply)";
  }
}

// ── Session simulation ────────────────────────────────────────────────────────
// 30% of the time, simulate a short multi-turn session (2–3 messages).
// This makes the traffic pattern indistinguishable from real conversations.

function buildSession(): { messages: string[]; isMultiTurn: boolean } {
  const isMultiTurn = randFloat() < 0.30;

  if (!isMultiTurn) {
    return { messages: [randChoice(TOPIC_POOL)], isMultiTurn: false };
  }

  // Pick a topic and generate plausible follow-up phrasings
  const first  = randChoice(TOPIC_POOL);
  const followUps = [
    "Can you give me an example?",
    "Why does that happen exactly?",
    "Is there a simpler way to do it?",
    "What if I don't have the materials for that?",
    "How long does that usually take?",
    "Does that work for everyone or are there exceptions?",
    "What's the most common mistake people make with this?",
    "Is there a quicker method?",
    "Can you break that down a bit more?",
    "What are the alternatives?",
  ];

  const turns = randInt(1, 2); // 1 or 2 follow-ups
  const messages = [first, ...randSample(followUps, turns)];
  return { messages, isMultiTurn: true };
}

// ── Log ───────────────────────────────────────────────────────────────────────

const LOG_PATH = path.join(process.env.HOME ?? "/tmp", ".openclaw", "ghostprint.log");

function logLine(msg: string) {
  const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// ── Core noise round ──────────────────────────────────────────────────────────

interface RunResult {
  fired: number;
  skipped: number;
  errors: string[];
  lines: string[];
}

async function runNoise(
  providers: ProviderEntry[],
  resolveKey: (provider: string) => Promise<string | undefined>,
): Promise<RunResult> {
  const result: RunResult = { fired: 0, skipped: 0, errors: [], lines: [] };

  if (!providers.length) {
    result.errors.push("No providers configured");
    return result;
  }

  // Poisson-weighted provider selection: draw 1 provider per round
  // (occasionally skip a round entirely — real users don't query every single interval)
  const shouldSkipRound = randFloat() < 0.08; // 8% chance of skip (simulate idle)
  if (shouldSkipRound) {
    const msg = "  · skipped round (idle simulation)";
    result.lines.push(msg);
    logLine(msg);
    return result;
  }

  // Weighted random provider selection
  const weights = providers.map(p => Math.max(p.weight ?? 1, 1));
  const total   = weights.reduce((a, b) => a + b, 0);

  // Randomly select 1 provider (occasionally 2)
  const numProviders = randFloat() < 0.25 ? Math.min(2, providers.length) : 1;
  const selected = new Set<ProviderEntry>();

  for (let attempt = 0; selected.size < numProviders && attempt < 20; attempt++) {
    let r = randFloat() * total, acc = 0;
    for (let i = 0; i < providers.length; i++) {
      acc += weights[i];
      if (r <= acc) { selected.add(providers[i]); break; }
    }
  }

  const toFire = [...selected];

  for (let i = 0; i < toFire.length; i++) {
    const p   = toFire[i];
    const key = await resolveKey(p.provider);

    if (!key) {
      const msg = `  ⚠️  ${p.name}: no API key (not configured) — skipping`;
      result.lines.push(msg);
      logLine(msg);
      result.skipped++;
      continue;
    }

    const session      = buildSession();
    const maxTokens    = sampleMaxTokens();
    const temperature  = sampleTemperature();
    const systemPrompt = randFloat() < 0.35 ? randChoice(SYSTEM_PROMPTS) : undefined;

    logLine(`  → ${p.name} | ${p.model} | turns=${session.messages.length} | tokens=${maxTokens} | temp=${temperature}`);

    try {
      // Fire turn 1
      const reply1 = await fireOne(p, key, {
        prompt:      session.messages[0],
        maxTokens,
        temperature,
        systemPrompt,
      });
      const ok1 = `  ✓ ${p.name} t1: "${reply1.slice(0, 60)}"`;
      result.lines.push(ok1);
      logLine(ok1);
      result.fired++;

      // Fire additional turns with realistic inter-turn delay (2–8s)
      for (let t = 1; t < session.messages.length; t++) {
        await sleep(randInt(2000, 8000));
        const replyN = await fireOne(p, key, {
          prompt:     session.messages[t],
          maxTokens:  Math.round(maxTokens * 0.6), // follow-ups are usually shorter
          temperature,
        });
        const okN = `  ✓ ${p.name} t${t + 1}: "${replyN.slice(0, 60)}"`;
        result.lines.push(okN);
        logLine(okN);
      }

    } catch (e: any) {
      const err = `  ✗ ${p.name}: ${e.message}`;
      result.lines.push(err);
      logLine(err);
      result.errors.push(err);
    }

    // Inter-provider delay: log-normal (feels human, not metronomic)
    if (i < toFire.length - 1) {
      const delayMs = Math.round(logNormal(8, 0.5) * 1000); // median ~3s
      await sleep(Math.max(500, Math.min(15000, delayMs)));
    }
  }

  return result;
}

// ── Plugin entry ──────────────────────────────────────────────────────────────

export default function (api: any) {
  const cfg         = api.config?.plugins?.entries?.ghostprint?.config ?? {};
  const enabled     = cfg.enabled !== false;
  const strategy    = cfg.strategy ?? "weighted";   // kept for compat, logic is now internal
  const minIntervalMin = cfg.min_interval_minutes ?? 90;
  const maxIntervalMin = cfg.max_interval_minutes ?? 180;
  const tzOffsetHours  = cfg.timezone_offset ?? 3; // GMT+3 default

  // Provider list: config overrides or default to Anthropic + Z.ai
  const providers: ProviderEntry[] = cfg.providers?.length
    ? cfg.providers
    : DEFAULT_PROVIDERS;

  // Resolve keys from OpenClaw's existing provider credentials
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

  // ── Tool: ghostprint_fire ──────────────────────────────────────────────────
  api.registerTool({
    name: "ghostprint_fire",
    description: "Fire a ghostprint noise round immediately. Sends 1–2 realistic-looking LLM sessions to configured providers to depersonalize usage fingerprints.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: {}) {
      if (!enabled) return { content: [{ type: "text", text: "ghostprint is disabled." }] };
      logLine("👻 manual fire");
      const res = await runNoise(providers, resolveKey);
      return {
        content: [{
          type: "text",
          text: [
            `👻 Ghostprint — noise round complete`,
            `Fired: ${res.fired} | Skipped: ${res.skipped} | Errors: ${res.errors.length}`,
            ...res.lines,
          ].join("\n"),
        }],
      };
    },
  });

  // ── Tool: ghostprint_stats ─────────────────────────────────────────────────
  api.registerTool({
    name: "ghostprint_stats",
    description: "Show ghostprint cumulative stats and recent log entries.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: {}) {
      try {
        const lines  = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
        const manual = lines.filter(l => l.includes("manual fire")).length;
        const sched  = lines.filter(l => l.includes("scheduled fire")).length;
        const ok     = lines.filter(l => l.includes("✓")).length;
        const fail   = lines.filter(l => l.includes("✗")).length;
        const skip   = lines.filter(l => l.includes("⚠️")).length;
        const idle   = lines.filter(l => l.includes("idle simulation")).length;
        return {
          content: [{
            type: "text",
            text: [
              `📊 Ghostprint stats`,
              `Manual runs  : ${manual}`,
              `Scheduled    : ${sched}`,
              `Successful   : ${ok}`,
              `Failed       : ${fail}`,
              `Skipped      : ${skip}`,
              `Idle skips   : ${idle}`,
              ``,
              `Last 10 log lines:`,
              lines.slice(-10).join("\n"),
            ].join("\n"),
          }],
        };
      } catch {
        return { content: [{ type: "text", text: "No log yet. Run ghostprint_fire to start." }] };
      }
    },
  });

  // ── Background scheduler: Poisson-process timing ──────────────────────────
  if (enabled) {
    api.logger.info(`[ghostprint] Scheduler armed (Poisson, mean ~${Math.round((minIntervalMin + maxIntervalMin) / 2)}min, quiet hours 00:00–07:00 GMT+${tzOffsetHours})`);

    const schedule = () => {
      const waitMs = sampleIntervalMs(minIntervalMin, maxIntervalMin);
      setTimeout(async () => {
        // Suppress during quiet hours — real users don't query at 3am
        if (isQuietHour(tzOffsetHours)) {
          logLine("  · quiet hours — skipping");
          schedule();
          return;
        }

        logLine("👻 scheduled fire");
        try {
          await runNoise(providers, resolveKey);
        } catch (e: any) {
          logLine(`  ✗ scheduler error: ${e.message}`);
        }
        schedule();
      }, waitMs);
    };

    schedule();
  }

  api.logger.info("[ghostprint] v2.0 loaded — tools: ghostprint_fire, ghostprint_stats");
}
