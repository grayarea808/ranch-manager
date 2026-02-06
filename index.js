import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits } from "discord.js";

dotenv.config();
const { Pool } = pg;

// ================= ENV =================
const PORT = process.env.PORT || 8080;

const BOT_TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ Missing Railway variable: DISCORD_TOKEN (or BOT_TOKEN)");
  process.exit(1);
}

const RANCH_INPUT_CHANNEL_ID =
  process.env.RANCH_INPUT_CHANNEL_ID ||
  process.env.INPUT_CHANNEL_ID ||
  process.env.LOG_CHANNEL_ID;

const RANCH_OUTPUT_CHANNEL_ID =
  process.env.RANCH_OUTPUT_CHANNEL_ID ||
  process.env.LEADERBOARD_CHANNEL_ID ||
  process.env.OUTPUT_CHANNEL_ID;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing Railway variable: DATABASE_URL");
  process.exit(1);
}
if (!RANCH_INPUT_CHANNEL_ID || !RANCH_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing Railway vars: RANCH_INPUT_CHANNEL_ID + RANCH_OUTPUT_CHANNEL_ID (or aliases)");
  process.exit(1);
}

const RANCH_ID = String(process.env.RANCH_ID || "164");
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 15);
const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";

// Prices
const MILK_PRICE = 1.25;
const EGGS_PRICE = 1.25;

// Herd profit math you confirmed: profit = sell - buy - 100
const RANCH_PROFIT_PER_HERD = 100;
const HERD_BUY = {
  bison: 300,
  deer: 250,
  sheep: 150,
};

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= EXPRESS =================
const app = express();
app.get("/", (_, res) => res.status(200).send("Ranch Manager running ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Web listening on ${PORT}`));

// ================= DISCORD =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// ================= SCHEMA =================
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.ranch_events (
      id BIGSERIAL PRIMARY KEY,
      discord_message_id TEXT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      eggs INT NOT NULL DEFAULT 0,
      milk INT NOT NULL DEFAULT 0,
      herd_profit NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.ranch_totals (
      user_id BIGINT PRIMARY KEY,
      eggs INT NOT NULL DEFAULT 0,
      milk INT NOT NULL DEFAULT 0,
      herd_profit NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureBotMessage(key, channelId, initialText) {
  const { rows } = await pool.query(
    `SELECT message_id FROM public.bot_messages WHERE key=$1 LIMIT 1`,
    [key]
  );

  const channel = await client.channels.fetch(channelId);

  if (rows.length) {
    const msgId = rows[0].message_id.toString();
    try {
      await channel.messages.fetch(msgId);
      return msgId;
    } catch {}
  }

  // invisible placeholder
  const msg = await channel.send({ content: "\u200B" });
  await msg.edit({ content: initialText, embeds: [] });

  await pool.query(
    `
    INSERT INTO public.bot_messages (key, channel_id, message_id, updated_at)
    VALUES ($1, $2::bigint, $3::bigint, NOW())
    ON CONFLICT (key)
    DO UPDATE SET channel_id=EXCLUDED.channel_id, message_id=EXCLUDED.message_id, updated_at=NOW()
    `,
    [key, channelId, msg.id]
  );

  return msg.id;
}

// ================= EXTRACTION =================
function extractAllText(message) {
  let text = (message.content || "").trim();

  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += `\n${e.title}`;
      if (e.description) text += `\n${e.description}`;
      if (e.author?.name) text += `\n${e.author.name}`;
      if (e.fields?.length) {
        for (const f of e.fields) {
          if (f.name) text += `\n${f.name}`;
          if (f.value) text += `\n${f.value}`;
        }
      }
      if (e.footer?.text) text += `\n${e.footer.text}`;
    }
  }

  return text.trim();
}

function ranchIdMatches(text) {
  const m = text.match(/ranch\s*id[:\s]+(\d+)/i);
  if (!m) return true; // if not present, don't discard
  return String(m[1]) === RANCH_ID;
}

function getUserId(message, text) {
  // best: parsed mention
  const first = message.mentions?.users?.first?.();
  if (first?.id) return first.id;

  // fallback: raw mention
  const mention = text.match(/<@!?(\d{17,19})>/);
  if (mention) return mention[1];

  // fallback: "@name id"
  const atLine = text.match(/@\S+\s+(\d{17,19})\b/);
  if (atLine) return atLine[1];

  // fallback: any snowflake
  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

// ================= MULTI-EVENT PARSE =================
function parseMulti(message) {
  const text = extractAllText(message);
  if (!text) return null;
  if (!ranchIdMatches(text)) return null;

  const userId = getUserId(message, text);
  if (!userId) return null;

  let eggs = 0;
  let milk = 0;
  let herd_profit = 0;

  // Eggs (can appear multiple times per message)
  const eggsRegex = /Added\s+Eggs[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;
  let m;
  while ((m = eggsRegex.exec(text)) !== null) eggs += Number(m[1] || 0);

  // Milk (can appear multiple times per message)
  const milkRegex = /Added\s+Milk[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;
  while ((m = milkRegex.exec(text)) !== null) milk += Number(m[1] || 0);

  // Cattle sale (profit does NOT multiply)
  // "sold 5 Bison for 1200.0$"
  const sale = text.match(/sold\s+\d+\s+(Bison|Deer|Sheep)\s+for\s+([0-9]+(?:\.[0-9]+)?)\$/i);
  if (sale) {
    const animal = sale[1].toLowerCase();
    const sell = Number(sale[2]);
    const buy = HERD_BUY[animal];
    if (typeof buy === "number") {
      herd_profit += (sell - buy - RANCH_PROFIT_PER_HERD);
    }
  }

  if (eggs === 0 && milk === 0 && herd_profit === 0) return null;

  return { userId, eggs, milk, herd_profit };
}

// ================= DB OPS =================
async function insertEvent(msgId, delta) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events (discord_message_id, user_id, eggs, milk, herd_profit)
    VALUES ($1, $2::bigint, $3::int, $4::int, $5::numeric)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [msgId, delta.userId, delta.eggs, delta.milk, delta.herd_profit]
  );
  return rowCount > 0;
}

async function rebuildTotals() {
  await pool.query(`TRUNCATE public.ranch_totals`);
  await pool.query(`
    INSERT INTO public.ranch_totals (user_id, eggs, milk, herd_profit, updated_at)
    SELECT
      user_id,
      COALESCE(SUM(eggs),0)::int,
      COALESCE(SUM(milk),0)::int,
      COALESCE(SUM(herd_profit),0)::numeric,
      NOW()
    FROM public.ranch_events
    GROUP BY user_id
  `);
}

// ================= COMPACT LEADERBOARD =================
const BOARD_KEY = "ranch_weekly_ledger_compact";

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

async function updateBoard() {
  const msgId = await ensureBotMessage(
    BOARD_KEY,
    RANCH_OUTPUT_CHANNEL_ID,
    "🏆 Beaver Farms — Weekly Ledger (Compact)\n\n(loading)"
  );

  const channel = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(`
    SELECT user_id, eggs, milk, herd_profit
    FROM public.ranch_totals
    WHERE eggs>0 OR milk>0 OR herd_profit<>0
  `);

  const players = rows.map(r => {
    const eggs = Number(r.eggs);
    const milk = Number(r.milk);
    const herdProfit = Number(r.herd_profit);
    const payout = (eggs * EGGS_PRICE) + (milk * MILK_PRICE) + herdProfit;
    return { user_id: r.user_id.toString(), eggs, milk, herdProfit, payout };
  });

  players.sort((a, b) => b.payout - a.payout);

  let out = `🏆 **Beaver Farms — Weekly Ledger (Compact)**\n`;
  out += `🥚$${EGGS_PRICE} • 🥛$${MILK_PRICE} • 🐄 profit from sales\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  const max = 50; // fits lots of people
  for (let i = 0; i < Math.min(players.length, max); i++) {
    const p = players[i];
    const rank = medals[i] || `#${i + 1}`;
    out += `${rank} <@${p.user_id}> | 🥚${p.eggs} 🥛${p.milk} 🐄${money(p.herdProfit)} | 💰 **${money(p.payout)}**\n`;
  }

  const payroll = players.reduce((a, p) => a + p.payout, 0);
  out += `\n---\n💼 **Total Ranch Payroll:** ${money(payroll)}`;

  await msg.edit({ content: out, embeds: [] });
  console.log("📊 Leaderboard updated");
}

// ================= POLLER =================
async function pollOnce() {
  const channel = await client.channels.fetch(RANCH_INPUT_CHANNEL_ID);

  // This will FAIL silently if bot lacks Read Message History
  const batch = await channel.messages.fetch({ limit: 100 });

  if (DEBUG) console.log(`POLL: fetched ${batch.size} msgs from logs channel`);

  let inserted = 0;
  for (const msg of batch.values()) {
    const delta = parseMulti(msg);
    if (!delta) continue;

    const ok = await insertEvent(msg.id, delta);
    if (ok) inserted++;

    if (DEBUG && ok) {
      console.log(`PARSED+INSERTED msg=${msg.id} user=${delta.userId} eggs=${delta.eggs} milk=${delta.milk} herd=${delta.herd_profit}`);
    }
  }

  if (inserted > 0) {
    await rebuildTotals();
    await updateBoard();
  } else if (DEBUG) {
    console.log("POLL: nothing new inserted");
  }
}

function startPolling() {
  setInterval(() => {
    pollOnce().catch(e => console.error("❌ pollOnce error:", e));
  }, POLL_SECONDS * 1000);
}

// ================= STARTUP =================
client.once("clientReady", async () => {
  try {
    console.log(`🚜 Ranch Manager Online: ${client.user.tag}`);
    await ensureSchema();

    // do one immediate poll so you see changes fast
    await pollOnce();
    await rebuildTotals();
    await updateBoard();

    startPolling();
    console.log(`✅ Polling log channel every ${POLL_SECONDS}s`);
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

// ================= SHUTDOWN =================
async function shutdown(signal) {
  console.log(`🛑 ${signal} received. Shutting down...`);
  try {
    await client.destroy().catch(() => {});
    await pool.end().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  } catch {
    process.exit(1);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

client.login(BOT_TOKEN);
