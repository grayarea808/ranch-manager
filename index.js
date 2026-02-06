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
  console.error("❌ Missing Railway variables: RANCH_INPUT_CHANNEL_ID + RANCH_OUTPUT_CHANNEL_ID (or aliases)");
  process.exit(1);
}

const RANCH_ID = String(process.env.RANCH_ID || "164");
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 20);

// Prices
const MILK_PRICE = 1.25;
const EGGS_PRICE = 1.25;

// Herd rules you confirmed:
// profit = sell - buy - 100 (ranch profit)
const RANCH_PROFIT_PER_HERD = 100;
const HERD_ANIMALS = {
  bison: { buy: 300 },
  deer: { buy: 250 },
  sheep: { buy: 150 },
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

    CREATE TABLE IF NOT EXISTS public.bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
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

async function getState(key, fallback = null) {
  const { rows } = await pool.query(`SELECT value FROM public.bot_state WHERE key=$1 LIMIT 1`, [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setState(key, value) {
  await pool.query(
    `
    INSERT INTO public.bot_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `,
    [key, String(value)]
  );
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

  // invisible placeholder so it doesn't show “Loading…”
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

function getUserIdFromMessage(message, text) {
  // best: parsed mentions
  const first = message.mentions?.users?.first?.();
  if (first?.id) return first.id;

  // fallback: raw mention in text
  const mention = text.match(/<@!?(\d{17,19})>/);
  if (mention) return mention[1];

  // fallback: "@name 123..."
  const atLine = text.match(/@\S+\s+(\d{17,19})\b/);
  if (atLine) return atLine[1];

  // fallback: any snowflake
  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

function ranchIdMatches(text) {
  // Accept both forms:
  // "Added Milk to ranch id 164 : 18"
  // "Ranch ID: 164"
  const m = text.match(/ranch\s*id[:\s]+(\d+)/i);
  if (!m) return true; // if ranch id missing, don't discard
  return String(m[1]) === RANCH_ID;
}

// ================= MULTI-EVENT PARSER =================
// IMPORTANT: can return multiple deltas for ONE message (Eggs + Milk, etc.)
function parseRanchLogMulti(message) {
  const text = extractAllText(message);
  if (!text) return [];

  if (!ranchIdMatches(text)) return [];

  const userId = getUserIdFromMessage(message, text);
  if (!userId) return [];

  const deltas = [];

  // Eggs Added (can appear multiple times, we sum all matches)
  const eggsRegex = /Added\s+Eggs[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;
  let m;
  let eggsSum = 0;
  while ((m = eggsRegex.exec(text)) !== null) {
    eggsSum += Number(m[1] || 0);
  }
  if (eggsSum > 0) deltas.push({ userId, eggs: eggsSum, milk: 0, herd_profit: 0 });

  // Milk Added (can appear multiple times, sum)
  const milkRegex = /Added\s+Milk[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;
  let milkSum = 0;
  while ((m = milkRegex.exec(text)) !== null) {
    milkSum += Number(m[1] || 0);
  }
  if (milkSum > 0) deltas.push({ userId, eggs: 0, milk: milkSum, herd_profit: 0 });

  // Cattle Sale line:
  // "Player @Peter ... sold 5 Bison for 1200.0$"
  // Profit = sell - buy - 100 (does NOT multiply)
  const saleRegex = /sold\s+\d+\s+(Bison|Deer|Sheep)\s+for\s+([0-9]+(?:\.[0-9]+)?)\$/i;
  const sale = text.match(saleRegex);
  if (sale) {
    const animal = sale[1].toLowerCase();
    const sell = Number(sale[2]);
    const buy = HERD_ANIMALS[animal]?.buy;

    if (typeof buy === "number") {
      const profit = sell - buy - RANCH_PROFIT_PER_HERD;
      deltas.push({ userId, eggs: 0, milk: 0, herd_profit: profit });
    }
  }

  return deltas;
}

// ================= DB OPS =================
async function insertEvent(discordMessageId, delta) {
  // One row per Discord message ID — BUT if a message contains multiple deltas,
  // we need them combined into a single insert.
  // We'll handle that outside by combining first.
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events (discord_message_id, user_id, eggs, milk, herd_profit)
    VALUES ($1, $2::bigint, $3::int, $4::int, $5::numeric)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [discordMessageId, delta.userId, delta.eggs, delta.milk, delta.herd_profit]
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
    "🏆 Beaver Farms — Weekly Ledger\n\n(loading)"
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

  // super compact: one line per person
  let out = `🏆 **Beaver Farms — Weekly Ledger (Compact)**\n`;
  out += `Prices: 🥚$${EGGS_PRICE} • 🥛$${MILK_PRICE} • Herd profit rules active\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  const maxLines = 40; // fits way more people
  for (let i = 0; i < Math.min(players.length, maxLines); i++) {
    const p = players[i];
    const rank = medals[i] || `#${i + 1}`;
    out += `${rank} <@${p.user_id}>  | 🥚${p.eggs} 🥛${p.milk} 🐄${money(p.herdProfit)} | 💰 **${money(p.payout)}**\n`;
  }

  const payroll = players.reduce((a, p) => a + p.payout, 0);
  out += `\n---\n💼 **Total Ranch Payroll:** ${money(payroll)}`;

  await msg.edit({ content: out, embeds: [] });
  console.log("📊 Leaderboard updated");
}

// ================= POLLING =================
// Poll channel and process any messages after last_seen_id
const STATE_LAST_ID = "ranch_last_seen_message_id";

async function processNewLogsOnce() {
  const channel = await client.channels.fetch(RANCH_INPUT_CHANNEL_ID);

  let lastSeen = await getState(STATE_LAST_ID, null);
  let fetchedAny = false;

  while (true) {
    const batch = await channel.messages.fetch(
      lastSeen ? { limit: 100, after: lastSeen } : { limit: 100 }
    );

    if (!batch.size) break;

    // Sort oldest -> newest
    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      fetchedAny = true;

      const deltas = parseRanchLogMulti(msg);
      if (deltas.length) {
        // Combine multiple deltas into one insert for this message id
        const combined = deltas.reduce(
          (acc, d) => ({
            userId: d.userId,
            eggs: acc.eggs + (d.eggs || 0),
            milk: acc.milk + (d.milk || 0),
            herd_profit: acc.herd_profit + (d.herd_profit || 0),
          }),
          { userId: deltas[0].userId, eggs: 0, milk: 0, herd_profit: 0 }
        );

        await insertEvent(msg.id, combined);
      }

      lastSeen = msg.id;
      await setState(STATE_LAST_ID, lastSeen);
    }

    // If Discord returns <=100, we might still have more after lastSeen; loop again.
    if (sorted.length < 100) break;
  }

  if (fetchedAny) {
    await rebuildTotals();
    await updateBoard();
  }
}

function startPolling() {
  setInterval(() => {
    processNewLogsOnce().catch(e => console.error("❌ poll error:", e));
  }, POLL_SECONDS * 1000);
}

// ================= STARTUP =================
client.once("clientReady", async () => {
  try {
    console.log(`🚜 Ranch Manager Online: ${client.user.tag}`);
    await ensureSchema();

    // Initialize lastSeen on first boot if empty:
    let lastSeen = await getState(STATE_LAST_ID, null);
    if (!lastSeen) {
      // set lastSeen to the newest message so we don't re-process whole history by accident
      const channel = await client.channels.fetch(RANCH_INPUT_CHANNEL_ID);
      const newest = await channel.messages.fetch({ limit: 1 });
      const newestMsg = newest.first();
      if (newestMsg) {
        await setState(STATE_LAST_ID, newestMsg.id);
        console.log(`🧠 Initialized lastSeen to newest msg: ${newestMsg.id}`);
      }
    }

    // One immediate pass (will catch new users right away)
    await processNewLogsOnce();

    // Start polling forever
    startPolling();

    console.log(`✅ Polling logs every ${POLL_SECONDS}s`);
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
