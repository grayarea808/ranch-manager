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
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

if (!DATABASE_URL || !INPUT_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID) {
  console.error("❌ Missing required Railway variables.");
  process.exit(1);
}

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 3000);

const EGG_PRICE = 1.25;
const MILK_PRICE = 1.25;
const RANCH_PROFIT_PER_SALE = 100;

// Herd sale values
const HERD_ANIMALS = {
  bison: { buy: 300, sell: 1200 },
  deer: { buy: 250, sell: 1000 },
  sheep: { buy: 150, sell: 900 },
};

function herdPayout(animalKey) {
  const v = HERD_ANIMALS[animalKey];
  if (!v) return 0;
  return Math.max(0, (v.sell - v.buy) - RANCH_PROFIT_PER_SALE);
}

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// ================= EXPRESS =================
const app = express();
app.get("/", (_, res) => res.status(200).send("Ranch Manager running ✅"));
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Web server listening on ${PORT}`)
);

// ================= DISCORD =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) =>
  console.error("❌ Unhandled Rejection:", r)
);
process.on("uncaughtException", (e) =>
  console.error("❌ Uncaught Exception:", e)
);

// ================= STATIC MESSAGE =================
async function ensureBotMessage(key, channelId, initialText) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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

// ================= PARSER =================
function parseMessage(message) {
  let text = (message.content || "").trim();

  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += `\n${e.title}`;
      if (e.description) text += `\n${e.description}`;
      if (e.fields?.length) {
        for (const f of e.fields) {
          text += `\n${f.name || ""}\n${f.value || ""}`;
        }
      }
    }
  }

  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;

  const userId = userMatch[1];
  const ranchMatch = text.match(/Ranch ID:\s*(\d+)/i);
  const ranchId = ranchMatch ? Number(ranchMatch[1]) : null;

  const qtyMatch = text.match(/:\s*(\d+)\s*$/m);
  const qty = qtyMatch ? Number(qtyMatch[1]) : 0;

  if (/Eggs Added|Added Eggs/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "eggs", amount: qty };
  }

  if (/Milk Added|Added Milk/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "milk", amount: qty };
  }

  const lower = text.toLowerCase();
  if (/sold/i.test(lower)) {
    if (lower.includes("bison"))
      return { userId, ranchId, item: "cattle", amount: herdPayout("bison") };
    if (lower.includes("deer"))
      return { userId, ranchId, item: "cattle", amount: herdPayout("deer") };
    if (lower.includes("sheep"))
      return { userId, ranchId, item: "cattle", amount: herdPayout("sheep") };
  }

  return null;
}

// ================= DB FUNCTIONS =================
async function insertEvent(messageId, data) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events
    (discord_message_id, user_id, ranch_id, item, amount, meta)
    VALUES ($1,$2::bigint,$3,$4,$5::numeric,'{}')
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [messageId, data.userId, data.ranchId, data.item, data.amount]
  );
  return rowCount > 0;
}

async function rebuildTotals() {
  await pool.query(`
    INSERT INTO public.ranch_totals (user_id)
    SELECT DISTINCT user_id FROM public.ranch_events
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`UPDATE public.ranch_totals SET eggs=0,milk=0,cattle=0`);

  await pool.query(`
    WITH agg AS (
      SELECT user_id,
        SUM(CASE WHEN item='eggs' THEN amount ELSE 0 END)::int eggs,
        SUM(CASE WHEN item='milk' THEN amount ELSE 0 END)::int milk,
        SUM(CASE WHEN item='cattle' THEN amount ELSE 0 END) cattle
      FROM public.ranch_events
      GROUP BY user_id
    )
    UPDATE public.ranch_totals t
    SET eggs=agg.eggs,
        milk=agg.milk,
        cattle=agg.cattle
    FROM agg
    WHERE t.user_id=agg.user_id
  `);
}

// ================= BACKFILL =================
async function backfill(maxMessages) {
  const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
  let lastId = null;
  let scanned = 0;

  while (scanned < maxMessages) {
    const batch = await channel.messages.fetch(
      lastId ? { limit: 100, before: lastId } : { limit: 100 }
    );
    if (!batch.size) break;

    const sorted = [...batch.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    for (const msg of sorted) {
      scanned++;
      if (!msg.webhookId && !msg.author?.bot) continue;

      const parsed = parseMessage(msg);
      if (!parsed) continue;

      await insertEvent(msg.id, parsed);
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Backfill complete. Scanned ${scanned} messages.`);
}

// ================= LEADERBOARD =================
async function updateLeaderboard() {
  const msgId = await ensureBotMessage(
    "ranch_board",
    LEADERBOARD_CHANNEL_ID,
    "🏆 Beaver Farms — Weekly Ledger\nLoading..."
  );

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(
    `
    SELECT user_id, eggs, milk, cattle,
      (eggs*$1 + milk*$2 + cattle) AS payout
    FROM public.ranch_totals
    WHERE eggs>0 OR milk>0 OR cattle>0
    ORDER BY payout DESC
    `,
    [EGG_PRICE, MILK_PRICE]
  );

  let total = 0;
  let out = "🏆 **Beaver Farms — Weekly Ledger (Top Earners)**\n\n";
  const medals = ["🥇","🥈","🥉"];

  rows.forEach((r,i)=>{
    const payout = Number(r.payout);
    total += payout;
    const badge = medals[i] || `#${i+1}`;
    out +=
      `**${badge} <@${r.user_id}>**\n` +
      `🥚 Eggs: ${r.eggs}\n` +
      `🥛 Milk: ${r.milk}\n` +
      `🐄 Herd Profit: $${Number(r.cattle).toFixed(2)}\n` +
      `💰 **$${payout.toFixed(2)}**\n\n`;
  });

  out += `---\n💼 **Total Ranch Payroll:** $${total.toFixed(2)}`;

  await msg.edit(out);
  console.log("📊 Leaderboard updated");
}

// ================= LIVE =================
client.on("messageCreate", async (message)=>{
  if(message.channel.id!==INPUT_CHANNEL_ID) return;
  if(!message.webhookId && !message.author?.bot) return;

  const parsed=parseMessage(message);
  if(!parsed) return;

  const inserted=await insertEvent(message.id,parsed);
  if(inserted){
    await rebuildTotals();
    await updateLeaderboard();
  }
});

// ================= START =================
client.once("clientReady", async ()=>{
  console.log(`🚜 Ranch Manager online as ${client.user.tag}`);

  if(BACKFILL_ON_START){
    await backfill(BACKFILL_MAX_MESSAGES);
  }

  await rebuildTotals();
  await updateLeaderboard();
  console.log("✅ Startup complete.");
});

client.login(BOT_TOKEN);
