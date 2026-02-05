import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits } from "discord.js";

dotenv.config();
const { Pool } = pg;

// ===== ENV =====
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID; // ranch logs
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID; // static board

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 3000);

const EGG_PRICE = 1.25;
const MILK_PRICE = 1.25;

// Herd sale payout (your latest rule)
const RANCH_PROFIT_PER_SALE = Number(process.env.RANCH_PROFIT_PER_SALE || 100);
const HERD_ANIMALS = {
  bison: { buy: 300, sell: 1200 }, // 1200-300-100=800
  deer: { buy: 250, sell: 1000 },  // 1000-250-100=650
  sheep: { buy: 150, sell: 900 },  // 900-150-100=650
};

function herdPayout(animalKey) {
  const v = HERD_ANIMALS[animalKey];
  if (!v) return 0;
  return Math.max(0, (v.sell - v.buy) - RANCH_PROFIT_PER_SALE);
}

function requireEnv(name) {
  if (!process.env[name] || String(process.env[name]).trim() === "") {
    console.error(`❌ Missing Railway variable: ${name}`);
    process.exit(1);
  }
}
requireEnv("BOT_TOKEN");
requireEnv("DATABASE_URL");
requireEnv("INPUT_CHANNEL_ID");
requireEnv("LEADERBOARD_CHANNEL_ID");

// ===== DB =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// ===== EXPRESS (keeps Railway alive) =====
const app = express();
app.get("/", (_, res) => res.status(200).send("Ranch Manager online ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Web listening on ${PORT}`));

// ===== DISCORD =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// ===== STATIC MESSAGE =====
async function ensureBotMessage(key, channelId, initialText) {
  const { rows } = await pool.query(`SELECT message_id FROM public.bot_messages WHERE key=$1 LIMIT 1`, [key]);
  const channel = await client.channels.fetch(channelId);

  if (rows.length) {
    const msgId = rows[0].message_id.toString();
    try {
      await channel.messages.fetch(msgId);
      return msgId;
    } catch {
      // deleted -> recreate
    }
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

// ===== PARSER =====
function parseRanchMessage(message) {
  let text = (message.content || "").trim();

  // include embeds if any
  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += `\n${e.title}`;
      if (e.description) text += `\n${e.description}`;
      if (e.fields?.length) {
        for (const f of e.fields) {
          if (f.name) text += `\n${f.name}`;
          if (f.value) text += `\n${f.value}`;
        }
      }
    }
  }
  text = text.trim();
  if (!text) return null;

  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;
  const userId = userMatch[1];

  const ranchIdMatch = text.match(/Ranch ID:\s*(\d+)/i) || text.match(/ranch id\s*(\d+)/i);
  const ranchId = ranchIdMatch ? Number(ranchIdMatch[1]) : null;

  // eggs/milk: "... : 33" near end
  const qtyMatch = text.match(/:\s*(\d+)\s*$/m);
  const qty = qtyMatch ? Number(qtyMatch[1]) : 0;

  if (/Eggs Added|Added Eggs/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "eggs", amount: qty, meta: { type: "add" } };
  }

  if (/Milk Added|Added Milk/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "milk", amount: qty, meta: { type: "add" } };
  }

  // herd sale keyword + animal name
  const lower = text.toLowerCase();
  const hasSale = /cattle sale/i.test(text) || /\bsold\b/i.test(text);
  if (hasSale) {
    let animal = null;
    if (lower.includes("bison")) animal = "bison";
    else if (lower.includes("deer")) animal = "deer";
    else if (lower.includes("sheep")) animal = "sheep";

    if (animal) {
      return {
        userId,
        ranchId,
        item: "cattle",
        amount: herdPayout(animal),
        meta: { type: "herd_sale", animal },
      };
    }
  }

  return null;
}

// ===== DB OPS =====
async function insertRanchEvent({ discordMessageId, userId, ranchId, item, amount, meta }) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events (discord_message_id, user_id, ranch_id, item, amount, meta)
    VALUES ($1, $2::bigint, $3, $4, $5::numeric, $6::jsonb)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [discordMessageId, userId, ranchId, item, amount, JSON.stringify(meta || {})]
  );
  return rowCount > 0;
}

async function rebuildTotalsFromEvents() {
  // ensure rows exist
  await pool.query(`
    INSERT INTO public.ranch_totals (user_id, eggs, milk, cattle)
    SELECT DISTINCT user_id, 0, 0, 0
    FROM public.ranch_events
    ON CONFLICT (user_id) DO NOTHING
  `);

  // reset totals
  await pool.query(`UPDATE public.ranch_totals SET eggs=0, milk=0, cattle=0, updated_at=NOW()`);

  // aggregate
  await pool.query(`
    WITH agg AS (
      SELECT user_id,
        COALESCE(SUM(CASE WHEN item='eggs' THEN amount ELSE 0 END),0)::int AS eggs,
        COALESCE(SUM(CASE WHEN item='milk' THEN amount ELSE 0 END),0)::int AS milk,
        COALESCE(SUM(CASE WHEN item='cattle' THEN amount ELSE 0 END),0)::numeric AS cattle
      FROM public.ranch_events
      GROUP BY user_id
    )
    UPDATE public.ranch_totals t
    SET eggs = agg.eggs,
        milk = agg.milk,
        cattle = agg.cattle,
        updated_at = NOW()
    FROM agg
    WHERE t.user_id = agg.user_id
  `);
}

// ===== BACKFILL =====
async function backfillFromHistory(maxMessages) {
  const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
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

      const isWebhookOrBot = Boolean(msg.webhookId) || Boolean(msg.author?.bot);
      if (!isWebhookOrBot) continue;

      const parsed = parseRanchMessage(msg);
      if (!parsed) continue;

      const ok = await insertRanchEvent({
        discordMessageId: msg.id,
        ...parsed,
      });
      if (ok) inserted++;
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Backfill complete: scanned=${scanned} inserted=${inserted}`);
}

// ===== LEADERBOARD UPDATE (static) =====
async function updateLeaderboard() {
  const msgId = await ensureBotMessage(
    "ranch_leaderboard",
    LEADERBOARD_CHANNEL_ID,
    "🏆 Beaver Farms — Weekly Ledger\nLoading..."
  );

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(
    `
    SELECT user_id, eggs, milk, cattle,
      (eggs * $1::numeric + milk * $2::numeric + cattle) AS payout
    FROM public.ranch_totals
    WHERE eggs > 0 OR milk > 0 OR cattle > 0
    ORDER BY payout DESC, cattle DESC, milk DESC, eggs DESC
    `,
    [EGG_PRICE, MILK_PRICE]
  );

  let total = 0;
  let out = "🏆 **Beaver Farms — Weekly Ledger (Top Earners)**\n\n";
  const medals = ["🥇","🥈","🥉"];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const eggs = Number(r.eggs);
    const milk = Number(r.milk);
    const cattle = Number(r.cattle);
    const payout = Number(r.payout);
    total += payout;

    const badge = medals[i] || `#${i + 1}`;
    out +=
      `**${badge} <@${r.user_id}>**\n` +
      `🥚 Eggs: ${eggs}\n` +
      `🥛 Milk: ${milk}\n` +
      `🐄 Herd Profit: $${cattle.toFixed(2)}\n` +
      `💰 **$${payout.toFixed(2)}**\n\n`;
  }

  out += `---\n💼 **Total Ranch Payroll:** $${total.toFixed(2)}`;
  await msg.edit(out);
  console.log("📊 Leaderboard updated");
}

// ===== LIVE UPDATES =====
let updateTimer = null;
function scheduleUpdate() {
  if (updateTimer) return;
  updateTimer = setTimeout(async () => {
    updateTimer = null;
    await rebuildTotalsFromEvents();
    await updateLeaderboard();
  }, 1500);
}

client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== INPUT_CHANNEL_ID) return;
    const isWebhookOrBot = Boolean(message.webhookId) || Boolean(message.author?.bot);
    if (!isWebhookOrBot) return;

    const parsed = parseRanchMessage(message);
    if (!parsed) return;

    const ok = await insertRanchEvent({ discordMessageId: message.id, ...parsed });
    if (ok) scheduleUpdate();
  } catch (e) {
    console.error("❌ messageCreate failed:", e);
  }
});

// ===== STARTUP =====
client.once("clientReady", async () => {
  try {
    console.log(`🚜 Ranch Manager online as ${client.user.tag}`);

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling ranch log history (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillFromHistory(BACKFILL_MAX_MESSAGES);
    }

    await rebuildTotalsFromEvents();
    await updateLeaderboard();

    console.log("✅ Startup complete.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

// ===== GRACEFUL SHUTDOWN =====
async function shutdown(signal) {
  console.log(`🛑 ${signal} received, shutting down...`);
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
