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
  console.error("❌ Missing Railway variable: BOT_TOKEN or DISCORD_TOKEN");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

if (!DATABASE_URL || !CAMP_INPUT_CHANNEL_ID || !CAMP_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing required Railway variables: DATABASE_URL / CAMP_INPUT_CHANNEL_ID / CAMP_OUTPUT_CHANNEL_ID");
  process.exit(1);
}

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 5000);

const CAMP_NAME = process.env.CAMP_NAME || "Baba Yaga Camp";
const NEXT_PAYOUT_LABEL = process.env.NEXT_PAYOUT_LABEL || "Saturday";

// Delivery tier values
const DELIVERY_VALUES = {
  small: 500,
  medium: 950,
  large: 1500,
};

// Sale values -> tier mapping
const SALE_VALUE_TO_TIER = {
  500: "small",
  950: "medium",
  1500: "large",
  1900: "large",
};

const CAMP_CUT = 0.30;
const MATERIAL_POINTS = 2;
const DELIVERY_POINTS = 3;
const SUPPLY_POINTS = 1;

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// ================= EXPRESS =================
const app = express();
app.get("/", (_, res) => res.status(200).send("Camp Tracker running ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
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

    CREATE TABLE IF NOT EXISTS public.camp_events (
      id BIGSERIAL PRIMARY KEY,
      discord_message_id TEXT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      item TEXT NOT NULL CHECK (item IN ('materials','supplies','small','medium','large')),
      amount INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.camp_totals (
      user_id BIGINT PRIMARY KEY,
      material_sets INT NOT NULL DEFAULT 0,
      supplies INT NOT NULL DEFAULT 0,
      small INT NOT NULL DEFAULT 0,
      medium INT NOT NULL DEFAULT 0,
      large INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ================= STATIC MESSAGE =================
// IMPORTANT: new key so it won't keep editing the old "square embed" message if that was stored.
const BOARD_KEY = "camp_board_text_v2";

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

  const msg = await channel.send(initialText);

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

// ================= PARSING =================
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

function extractUserId(text) {
  const m = text.match(/Discord:\s*@([^\s]+)\s+(\d{17,19})/i);
  if (m) return m[2];

  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

function parseCampLog(message) {
  const text = extractAllText(message);
  if (!text) return null;

  const userId = extractUserId(text);
  if (!userId) return null;

  const sup = text.match(/Delivered Supplies:\s*(\d+)/i);
  if (sup) {
    const amount = Number(sup[1] || 0);
    if (amount > 0) return { userId, item: "supplies", amount };
  }

  const mat = text.match(/Materials added:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (mat) {
    const amount = Math.floor(Number(mat[1] || 0));
    if (amount > 0) return { userId, item: "materials", amount };
  }

  const sale = text.match(/Made a Sale Of\s+\d+\s+Of Stock For\s+\$([0-9]+(?:\.[0-9]+)?)/i);
  if (sale) {
    const value = Math.round(Number(sale[1]));
    const tier = SALE_VALUE_TO_TIER[value];
    if (tier) return { userId, item: tier, amount: 1 };
  }

  return null;
}

// ================= DB OPS =================
async function insertEvent(discordMessageId, parsed) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.camp_events (discord_message_id, user_id, item, amount)
    VALUES ($1, $2::bigint, $3, $4::int)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [discordMessageId, parsed.userId, parsed.item, parsed.amount]
  );
  return rowCount > 0;
}

async function rebuildTotals() {
  await pool.query(`TRUNCATE public.camp_totals`);

  await pool.query(`
    INSERT INTO public.camp_totals (user_id, material_sets, supplies, small, medium, large, updated_at)
    SELECT
      user_id,
      COALESCE(SUM(CASE WHEN item='materials' THEN amount ELSE 0 END),0)::int AS material_sets,
      COALESCE(SUM(CASE WHEN item='supplies' THEN amount ELSE 0 END),0)::int AS supplies,
      COALESCE(SUM(CASE WHEN item='small' THEN amount ELSE 0 END),0)::int AS small,
      COALESCE(SUM(CASE WHEN item='medium' THEN amount ELSE 0 END),0)::int AS medium,
      COALESCE(SUM(CASE WHEN item='large' THEN amount ELSE 0 END),0)::int AS large,
      NOW()
    FROM public.camp_events
    GROUP BY user_id
  `);
}

// ================= BACKFILL =================
async function backfillFromHistory(maxMessages) {
  const channel = await client.channels.fetch(CAMP_INPUT_CHANNEL_ID);

  let lastId = null;
  let scanned = 0;
  let parsedCount = 0;
  let inserted = 0;

  while (scanned < maxMessages) {
    const batchSize = Math.min(100, maxMessages - scanned);
    const batch = await channel.messages.fetch(lastId ? { limit: batchSize, before: lastId } : { limit: batchSize });
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      scanned++;
      if (!msg.webhookId && !msg.author?.bot) continue;

      const parsed = parseCampLog(msg);
      if (!parsed) continue;
      parsedCount++;

      const ok = await insertEvent(msg.id, parsed);
      if (ok) inserted++;
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Camp backfill: scanned=${scanned} parsed=${parsedCount} inserted=${inserted}`);
}

// ================= MATH =================
function computePoints(p) {
  const deliveries = p.small + p.medium + p.large;
  return (p.material_sets * MATERIAL_POINTS) + (deliveries * DELIVERY_POINTS) + (p.supplies * SUPPLY_POINTS);
}

function totalDeliveryValue(p) {
  return (p.small * DELIVERY_VALUES.small) +
         (p.medium * DELIVERY_VALUES.medium) +
         (p.large * DELIVERY_VALUES.large);
}

// ================= OUTPUT (PLAIN TEXT ONLY) =================
async function updateCampBoard() {
  const msgId = await ensureBotMessage(
    BOARD_KEY,
    CAMP_OUTPUT_CHANNEL_ID,
    `🏕️ ${CAMP_NAME}\nLoading...`
  );

  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(`
    SELECT user_id, material_sets, supplies, small, medium, large
    FROM public.camp_totals
    WHERE material_sets>0 OR supplies>0 OR small>0 OR medium>0 OR large>0
  `);

  const players = rows.map(r => {
    const p = {
      user_id: r.user_id.toString(),
      material_sets: Number(r.material_sets),
      supplies: Number(r.supplies),
      small: Number(r.small),
      medium: Number(r.medium),
      large: Number(r.large),
    };
    p.deliveries = p.small + p.medium + p.large;
    p.points = computePoints(p);
    p.delValue = totalDeliveryValue(p);
    return p;
  });

  const gross = players.reduce((a, p) => a + p.delValue, 0);
  const playerPool = gross * (1 - CAMP_CUT);
  const campRevenue = gross * CAMP_CUT;
  const totalPoints = players.reduce((a, p) => a + p.points, 0);
  const valuePerPoint = totalPoints > 0 ? (playerPool / totalPoints) : 0;

  for (const p of players) p.payout = p.points * valuePerPoint;

  players.sort((a, b) => b.payout - a.payout || b.points - a.points);

  let out =
    `🏕️ **${CAMP_NAME}**\n` +
    `📅 Next Camp Payout: **${NEXT_PAYOUT_LABEL}**\n` +
    `Payout Mode: **Points (30% camp fee)**\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  for (let i = 0; i < Math.min(players.length, 25); i++) {
    const p = players[i];
    const badge = medals[i] || `#${i + 1}`;

    out +=
      `**${badge} <@${p.user_id}>**\n` +
      `🪨 Materials: ${p.material_sets}\n` +
      `🚚 Deliveries: ${p.deliveries} (S:${p.small} M:${p.medium} L:${p.large})\n` +
      `📦 Supplies: ${p.supplies}\n` +
      `⭐ Points: ${p.points}\n` +
      `💰 **$${p.payout.toFixed(2)}**\n\n`;
  }

  out += `---\n🧾 Total Delivery Value: $${Math.round(gross)} • 💰 Camp Revenue: $${Math.round(campRevenue)} • ⭐ Total Points: ${totalPoints}`;

  // ensure no embed stays attached
  await msg.edit({ content: out, embeds: [] });
  console.log("📊 Camp board updated (text only)");
}

// ================= LIVE UPDATES =================
let debounce = null;
function scheduleUpdate() {
  if (debounce) return;
  debounce = setTimeout(async () => {
    debounce = null;
    await rebuildTotals();
    await updateCampBoard();
  }, 1500);
}

client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== CAMP_INPUT_CHANNEL_ID) return;
    if (!message.webhookId && !message.author?.bot) return;

    const parsed = parseCampLog(message);
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
    console.log(`🏕️ Camp Manager Online: ${client.user.tag}`);
    await ensureSchema();

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling camp history (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillFromHistory(BACKFILL_MAX_MESSAGES);
    }

    await rebuildTotals();
    await updateCampBoard();

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
