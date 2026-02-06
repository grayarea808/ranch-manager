import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits } from "discord.js";

dotenv.config();
const { Pool } = pg;

// ================= ENV =================
const PORT = process.env.PORT || 8080;

const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ Missing Railway variable: DISCORD_TOKEN (or BOT_TOKEN)");
  process.exit(1);
}

const RANCH_INPUT_CHANNEL_ID = process.env.RANCH_INPUT_CHANNEL_ID;
const RANCH_OUTPUT_CHANNEL_ID = process.env.RANCH_OUTPUT_CHANNEL_ID;
const RANCH_ID = String(process.env.RANCH_ID || "164");

if (!RANCH_INPUT_CHANNEL_ID || !RANCH_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing Railway variables: RANCH_INPUT_CHANNEL_ID / RANCH_OUTPUT_CHANNEL_ID");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing Railway variable: DATABASE_URL");
  process.exit(1);
}

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 5000);

// Prices
const MILK_PRICE = 1.25;
const EGGS_PRICE = 1.25;

// Herd profit rules (optional, if you parse herding completed/sales later)
const RANCH_PROFIT_PER_HERD = 100;

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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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

  const msg = await channel.send({ content: initialText });

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

// ================= TEXT EXTRACTION =================
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

// ✅ MOST RELIABLE: use Discord parsed mentions first
function getUserIdFromMessage(message, text) {
  const mentioned = message.mentions?.users?.first?.();
  if (mentioned?.id) return mentioned.id;

  // fallback: <@123> or <@!123>
  const mention = text.match(/<@!?(\d{17,19})>/);
  if (mention) return mention[1];

  // fallback: "@name 123..."
  const atLine = text.match(/@\S+\s+(\d{17,19})\b/);
  if (atLine) return atLine[1];

  // fallback: any snowflake
  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

function getRanchIdIfPresent(text) {
  const a = text.match(/ranch id\s*(\d+)/i);
  return a ? a[1] : null;
}

// ================= PARSER =================
function parseRanchLog(message) {
  const text = extractAllText(message);
  if (!text) return null;

  const rid = getRanchIdIfPresent(text);
  if (rid && String(rid) !== RANCH_ID) return null;

  const userId = getUserIdFromMessage(message, text);
  if (!userId) return null;

  // Looser match: handles "Milk Added" line + "Added Milk to ranch id ..."
  const milkMatch = text.match(/Added\s+Milk[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/i);
  if (milkMatch) return { userId, eggs: 0, milk: Number(milkMatch[1]), herd_profit: 0 };

  const eggsMatch = text.match(/Added\s+Eggs[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/i);
  if (eggsMatch) return { userId, eggs: Number(eggsMatch[1]), milk: 0, herd_profit: 0 };

  // Optional: you can later parse herding completed into herd_profit if needed
  // Right now: just ensure milk/eggs ALWAYS count.

  return null;
}

// ================= DB OPS =================
async function insertEvent(discordMessageId, parsed) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events (discord_message_id, user_id, eggs, milk, herd_profit)
    VALUES ($1, $2::bigint, $3::int, $4::int, $5::numeric)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [discordMessageId, parsed.userId, parsed.eggs, parsed.milk, parsed.herd_profit]
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

// ================= BACKFILL =================
async function backfillFromHistory(maxMessages) {
  const channel = await client.channels.fetch(RANCH_INPUT_CHANNEL_ID);

  let lastId = null;
  let scanned = 0;
  let inserted = 0;

  while (scanned < maxMessages) {
    const batchSize = Math.min(100, maxMessages - scanned);
    const batch = await channel.messages.fetch(lastId ? { limit: batchSize, before: lastId } : { limit: batchSize });
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      scanned++;

      const parsed = parseRanchLog(msg);
      if (!parsed) continue;

      const ok = await insertEvent(msg.id, parsed);
      if (ok) inserted++;
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Ranch backfill: scanned=${scanned} inserted=${inserted}`);
}

// ================= LEADERBOARD =================
const BOARD_KEY = "ranch_weekly_ledger_text";
function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

async function updateBoard() {
  const msgId = await ensureBotMessage(
    BOARD_KEY,
    RANCH_OUTPUT_CHANNEL_ID,
    "🏆 Beaver Farms — Weekly Ledger\nLoading..."
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

  let out = `🏆 **Beaver Farms — Weekly Ledger (Top Earners)**\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  for (let i = 0; i < Math.min(players.length, 25); i++) {
    const p = players[i];
    const badge = medals[i] || `#${i + 1}`;

    out +=
      `**${badge} <@${p.user_id}>**\n` +
      `🥚 Eggs: ${p.eggs}\n` +
      `🥛 Milk: ${p.milk}\n` +
      `🐄 Herd Profit: ${money(p.herdProfit)}\n` +
      `💰 **${money(p.payout)}**\n\n`;
  }

  const payroll = players.reduce((a, p) => a + p.payout, 0);
  out += `---\n💼 **Total Ranch Payroll:** ${money(payroll)}`;

  await msg.edit({ content: out, embeds: [] });
  console.log("📊 Ranch board updated");
}

// ================= LIVE UPDATES =================
let debounce = null;
function scheduleUpdate() {
  if (debounce) return;
  debounce = setTimeout(async () => {
    debounce = null;
    await rebuildTotals();
    await updateBoard();
  }, 1500);
}

client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== RANCH_INPUT_CHANNEL_ID) return;

    const parsed = parseRanchLog(message);
    if (!parsed) return;

    const ok = await insertEvent(message.id, parsed);
    if (ok) scheduleUpdate();
  } catch (e) {
    console.error("❌ messageCreate error:", e);
  }
});

// ================= STARTUP =================
client.once("clientReady", async () => {
  try {
    console.log(`🚜 Ranch Manager Online: ${client.user.tag}`);
    await ensureSchema();

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling ranch history (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillFromHistory(BACKFILL_MAX_MESSAGES);
    }

    await rebuildTotals();
    await updateBoard();

    console.log("✅ Startup complete.");
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
