import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

dotenv.config();
const { Pool } = pg;

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 8080;

const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID; // ranch logs
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID; // static leaderboard
const HERD_CHANNEL_ID = process.env.HERD_CHANNEL_ID; // queue-only embed

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 5000);
const BACKFILL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 3000);
const LEADERBOARD_HARD_MIN_MS = Number(process.env.LEADERBOARD_HARD_MIN_MS || 5000);
const HERD_HARD_MIN_MS = Number(process.env.HERD_HARD_MIN_MS || 1200);

const PRICES = { eggs: 1.25, milk: 1.25 };

// Herd sale economics (ONE payout per finished sale message; no multiplying)
const HERD_ANIMAL_TOTALS = {
  bison: { buy: 300, sell: 1200 },
  deer: { buy: 250, sell: 1000 },
  sheep: { buy: 150, sell: 900 },
};
const RANCH_PROFIT_PER_SALE = Number(process.env.RANCH_PROFIT_PER_SALE || 100);
function herdCyclePayout(animalKey) {
  const v = HERD_ANIMAL_TOTALS[animalKey];
  return Math.max(0, (v.sell - v.buy) - RANCH_PROFIT_PER_SALE);
}

// Herd queue “free after 2 hours” rule
const HERD_STALE_HOURS = Number(process.env.HERD_STALE_HOURS || 2);

// =========================
// POSTGRES
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// =========================
// EXPRESS
// =========================
const app = express();
app.use(express.json());
app.get("/", (_, res) => res.status(200).send("Ranch Manager online ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Web server listening on port ${PORT}`);
});

// =========================
// DISCORD
// =========================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let leaderboardMessageId = null;
let herdMessageId = null;

// Leaderboard debounce + hard min interval
let lbTimer = null;
let lbQueued = false;
let lbLastEditAt = 0;

// Herd board hard min interval
let herdTimer = null;
let herdQueued = false;
let herdLastEditAt = 0;

// =========================
// TIME HELPERS
// =========================
function now() { return new Date(); }
function addHours(d, h) { return new Date(d.getTime() + h * 3600000); }
function formatTimeLeft(ms) {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.ceil(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// =========================
// STATIC MESSAGE STORAGE
// =========================
async function ensureBotMessage(key, channelId, initialText) {
  const { rows } = await pool.query(
    `SELECT message_id FROM public.bot_messages WHERE key = $1 LIMIT 1`,
    [key]
  );

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
    DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id, updated_at = NOW()
    `,
    [key, channelId, msg.id]
  );

  return msg.id;
}

// =========================
// HERD QUEUE DB HELPERS (queue-only)
// =========================
async function getQueue() {
  const { rows } = await pool.query(`SELECT user_id, joined_at FROM public.herd_queue ORDER BY joined_at ASC`);
  return rows.map((r) => ({ userId: r.user_id.toString(), joinedAt: r.joined_at }));
}

async function queueAdd(userId) {
  await pool.query(
    `INSERT INTO public.herd_queue (user_id, joined_at)
     VALUES ($1::bigint, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function queueRemove(userId) {
  await pool.query(`DELETE FROM public.herd_queue WHERE user_id = $1::bigint`, [userId]);
}

// =========================
// READY
// =========================
client.once("ready", async () => {
  try {
    console.log(`🚜 Ranch Manager online as ${client.user.tag}`);
    await pool.query("SELECT 1");
    console.log("✅ DB OK");

    leaderboardMessageId = await ensureBotMessage(
      "leaderboard",
      LEADERBOARD_CHANNEL_ID,
      "🏆 Beaver Farms — Weekly Ledger\nLoading..."
    );

    herdMessageId = await ensureBotMessage(
      "herd_queue",
      HERD_CHANNEL_ID,
      "🐎 Main Herd Queue\nLoading..."
    );

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfill on start: scanning up to ${BACKFILL_MAX_MESSAGES} messages...`);
      await backfillFromChannelHistory(BACKFILL_MAX_MESSAGES);
    }

    await scheduleLeaderboardUpdate(true);
    await scheduleHerdUpdate(true);

    // periodic backfill
    setInterval(async () => {
      try {
        await backfillFromChannelHistory(300);
        await scheduleLeaderboardUpdate(true);
      } catch (e) {
        console.error("❌ Periodic backfill failed:", e);
      }
    }, BACKFILL_EVERY_MS);

    // refresh queue time-left text periodically so it stays accurate without clicks
    setInterval(async () => {
      try {
        await scheduleHerdUpdate(true);
      } catch {}
    }, 60000);

    console.log("✅ Startup complete.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

// =========================
// RANCH LOG PARSER
// =========================
client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== INPUT_CHANNEL_ID) return;

    const isWebhookOrBot = Boolean(message.webhookId) || Boolean(message.author?.bot);
    if (!isWebhookOrBot) return;

    const parsed = parseRanchMessage(message);
    if (!parsed) return;

    const stored = await storeEventAndUpdateTotals({
      discordMessageId: message.id,
      ...parsed,
    });

    if (stored) await scheduleLeaderboardUpdate();
  } catch (e) {
    console.error("❌ messageCreate failed:", e);
  }
});

function parseRanchMessage(message) {
  let text = (message.content || "").trim();

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
  const userId = BigInt(userMatch[1]).toString();

  const ranchIdMatch = text.match(/Ranch ID:\s*(\d+)/i) || text.match(/ranch id\s*(\d+)/i);
  const ranchId = ranchIdMatch ? Number(ranchIdMatch[1]) : null;

  // Eggs/Milk add pattern ": 33"
  const addedMatch = text.match(/:\s*(\d+)\s*$/m);
  const qty = addedMatch ? Number(addedMatch[1]) : 0;

  if (/Eggs Added|Added Eggs/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "eggs", amount: qty };
  }

  if (/Milk Added|Added Milk/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "milk", amount: qty };
  }

  // Herd sale message -> ONE payout per sale message; fixed economy; minus $100 ranch profit
  const lower = text.toLowerCase();
  const hasSaleKeyword = /cattle sale/i.test(text) || /\bsold\b/i.test(text);
  if (hasSaleKeyword) {
    let animal = null;
    if (lower.includes("bison")) animal = "bison";
    else if (lower.includes("deer")) animal = "deer";
    else if (lower.includes("sheep")) animal = "sheep";

    if (animal) {
      const payout = herdCyclePayout(animal);
      return { userId, ranchId, item: "cattle", amount: payout };
    }
  }

  return null;
}

// =========================
// DB: Insert event (dedupe) + update totals
// =========================
async function storeEventAndUpdateTotals({ discordMessageId, userId, ranchId, item, amount }) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const ins = await c.query(
      `
      INSERT INTO public.ranch_events (discord_message_id, user_id, ranch_id, item, amount)
      VALUES ($1, $2::bigint, $3, $4, $5::numeric)
      ON CONFLICT (discord_message_id) DO NOTHING
      RETURNING id
      `,
      [discordMessageId, userId, ranchId, item, amount]
    );

    if (!ins.rowCount) {
      await c.query("ROLLBACK");
      return false;
    }

    await c.query(
      `
      INSERT INTO public.ranch_totals (user_id, eggs, milk, cattle)
      VALUES ($1::bigint, 0, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );

    await c.query(
      `
      UPDATE public.ranch_totals
      SET ${item} = ${item} + $2::numeric,
          updated_at = NOW()
      WHERE user_id = $1::bigint
      `,
      [userId, amount]
    );

    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("❌ DB transaction failed:", e);
    return false;
  } finally {
    c.release();
  }
}

// =========================
// BACKFILL (safe: dedupe by discord_message_id)
// =========================
async function backfillFromChannelHistory(max) {
  const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
  let lastId = null;
  let scanned = 0;

  while (scanned < max) {
    const batchSize = Math.min(100, max - scanned);
    const batch = await channel.messages.fetch(lastId ? { limit: batchSize, before: lastId } : { limit: batchSize });
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      scanned++;
      const isWebhookOrBot = Boolean(msg.webhookId) || Boolean(msg.author?.bot);
      if (!isWebhookOrBot) continue;

      const parsed = parseRanchMessage(msg);
      if (!parsed) continue;

      await storeEventAndUpdateTotals({ discordMessageId: msg.id, ...parsed });
    }

    lastId = sorted[0].id;
  }
}

// =========================
// LEADERBOARD (sorted in SQL)
// =========================
async function scheduleLeaderboardUpdate(immediate = false) {
  const since = Date.now() - lbLastEditAt;
  if (immediate && since < LEADERBOARD_HARD_MIN_MS) return;
  if (immediate) return updateLeaderboardMessage();

  lbQueued = true;
  if (lbTimer) return;

  lbTimer = setTimeout(async () => {
    lbTimer = null;
    if (!lbQueued) return;
    lbQueued = false;
    await updateLeaderboardMessage();
  }, LEADERBOARD_DEBOUNCE_MS);
}

async function updateLeaderboardMessage() {
  leaderboardMessageId = await ensureBotMessage(
    "leaderboard",
    LEADERBOARD_CHANNEL_ID,
    "🏆 Beaver Farms — Weekly Ledger\nLoading..."
  );

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const msg = await channel.messages.fetch(leaderboardMessageId);

  const { rows } = await pool.query(
    `
    SELECT
      user_id,
      eggs,
      milk,
      cattle,
      (eggs * $1::numeric + milk * $2::numeric + cattle) AS payout
    FROM public.ranch_totals
    WHERE eggs > 0 OR milk > 0 OR cattle > 0
    ORDER BY payout DESC, cattle DESC, milk DESC, eggs DESC
    `,
    [PRICES.eggs, PRICES.milk]
  );

  let total = 0;
  let out = "🏆 **Beaver Farms — Weekly Ledger (Top Earners)**\n\n";

  const medals = ["🥇", "🥈", "🥉"];
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
  lbLastEditAt = Date.now();
}

// =========================
// HERD QUEUE (EXACT “A” STYLE: queue-only embed + join/leave)
// =========================
function buildQueueButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("herd_join").setLabel("Join Queue").setEmoji("👑").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("herd_leave").setLabel("Leave Queue").setEmoji("📜").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function scheduleHerdUpdate(immediate = false) {
  const since = Date.now() - herdLastEditAt;
  if (immediate && since < HERD_HARD_MIN_MS) return;
  if (immediate) return updateHerdMessage();

  herdQueued = true;
  if (herdTimer) return;

  herdTimer = setTimeout(async () => {
    herdTimer = null;
    if (!herdQueued) return;
    herdQueued = false;
    await updateHerdMessage();
  }, 500);
}

async function updateHerdMessage() {
  herdMessageId = await ensureBotMessage(
    "herd_queue",
    HERD_CHANNEL_ID,
    "🐎 Main Herd Queue\nLoading..."
  );

  const channel = await client.channels.fetch(HERD_CHANNEL_ID);
  const msg = await channel.messages.fetch(herdMessageId);

  const queue = await getQueue();

  const embed = new EmbedBuilder()
    .setTitle("🐎 Main Herd Queue")
    .setColor(0x2b2d31);

  if (queue.length > 0) {
    const first = queue[0];
    const joinedAt = new Date(first.joinedAt);
    const expiresAt = addHours(joinedAt, HERD_STALE_HOURS);
    const leftMs = expiresAt.getTime() - now().getTime();
    const left = formatTimeLeft(leftMs);

    // EXACT format vibe:
    // 1. @User ⏳ (1h 22m left to sell)
    embed.setDescription(`**1. <@${first.userId}>** ⏳ *( ${left} left to sell )*`);
  } else {
    embed.setDescription("_No one in queue._");
  }

  await msg.edit({
    content: "",
    embeds: [embed],
    components: buildQueueButtons(),
  });

  herdLastEditAt = Date.now();
}

// =========================
// BUTTONS (SILENT, STATIC)
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    if (interaction.channelId !== HERD_CHANNEL_ID) {
      return interaction.deferUpdate().catch(() => {});
    }

    await interaction.deferUpdate(); // silent (no message spam)

    const userId = interaction.user.id;

    if (interaction.customId === "herd_join") {
      await queueAdd(userId);
      await scheduleHerdUpdate(true);
      return;
    }

    if (interaction.customId === "herd_leave") {
      await queueRemove(userId);
      await scheduleHerdUpdate(true);
      return;
    }
  } catch (e) {
    console.error("❌ interactionCreate failed:", e);
  }
});

// =========================
// GRACEFUL SHUTDOWN
// =========================
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

// =========================
// LOGIN
// =========================
client.login(process.env.BOT_TOKEN);
