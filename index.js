import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const { Pool } = pg;

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;

const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

const DEBUG = process.env.DEBUG === "true";
const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 3000);

const PRICES = { eggs: 1.25, milk: 1.25, cattle: 800 };

// ---------- CRASH LOGGING (SUPER IMPORTANT ON RAILWAY) ----------
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});

// ---------- POSTGRES ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres often requires SSL
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("Ranch Manager online ✅"));
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});

// KEEP A HANDLE so we can close it on SIGTERM
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Web server listening on port ${PORT}`);
});

// ---------- DISCORD ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let leaderboardMessageId = null;

// debounce state
let updateTimer = null;
let updateQueued = false;

// ---------- READY ----------
client.once("ready", async () => {
  try {
    console.log(`🚜 Ranch Manager online as ${client.user.tag}`);

    if (!INPUT_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID) {
      console.log("❌ Missing INPUT_CHANNEL_ID or LEADERBOARD_CHANNEL_ID in Railway variables");
      return;
    }

    // Quick DB sanity check at startup
    await pool.query("SELECT 1");
    console.log("✅ DB connection OK");

    await ensureLeaderboardMessage();
    await scheduleLeaderboardUpdate(true);

    console.log("✅ Startup complete. Listening for ranch logs…");
  } catch (err) {
    console.error("❌ Startup failed:", err);
    // If startup fails, exit so Railway restarts us cleanly
    process.exit(1);
  }
});

// ---------- MESSAGE LISTENER ----------
client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== INPUT_CHANNEL_ID) return;

    const isWebhookOrBot = Boolean(message.webhookId) || Boolean(message.author?.bot);
    if (!isWebhookOrBot) return;

    if (DEBUG) {
      console.log("INCOMING:", {
        id: message.id,
        content: message.content,
        webhookId: message.webhookId,
        embeds: message.embeds?.map((e) => ({
          title: e.title,
          description: e.description,
          fields: e.fields?.map((f) => ({ name: f.name, value: f.value })),
        })),
      });
    }

    const parsed = parseRanchMessageFromDiscordMessage(message);
    if (!parsed) return;

    const stored = await storeEventAndUpdateTotals({
      discordMessageId: message.id,
      ...parsed,
    });

    if (!stored) return;

    await scheduleLeaderboardUpdate();
  } catch (err) {
    console.error("❌ messageCreate handler failed:", err);
  }
});

// ---------- PARSER (EMBEDS + CONTENT) ----------
function parseRanchMessageFromDiscordMessage(message) {
  let text = (message.content || "").trim();

  if (message.embeds?.length) {
    for (const emb of message.embeds) {
      if (emb.title) text += `\n${emb.title}`;
      if (emb.description) text += `\n${emb.description}`;
      if (emb.fields?.length) {
        for (const f of emb.fields) {
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

  const ranchIdMatch = text.match(/ranch id\s*(\d+)/i);
  const ranchId = ranchIdMatch ? Number(ranchIdMatch[1]) : null;

  const amountMatch = text.match(/:\s*(\d+)\s*$/m);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;

  let item = null;
  if (/Eggs Added/i.test(text) || /Added Eggs/i.test(text)) item = "eggs";
  if (/Milk Added/i.test(text) || /Added Milk/i.test(text)) item = "milk";
  if (/Cattle Added/i.test(text) || /Added Cattle/i.test(text)) item = "cattle";

  if (!item || amount <= 0) return null;
  return { userId, ranchId, item, amount };
}

// ---------- DB: insert event + totals upsert ----------
async function storeEventAndUpdateTotals({ discordMessageId, userId, ranchId, item, amount }) {
  const clientDb = await pool.connect();
  try {
    await clientDb.query("BEGIN");

    const insertEvent = await clientDb.query(
      `
      INSERT INTO public.ranch_events (discord_message_id, user_id, ranch_id, item, amount)
      VALUES ($1, $2::bigint, $3, $4, $5)
      ON CONFLICT (discord_message_id) DO NOTHING
      RETURNING id
      `,
      [discordMessageId, userId, ranchId, item, amount]
    );

    if (insertEvent.rowCount === 0) {
      await clientDb.query("ROLLBACK");
      return false;
    }

    await clientDb.query(
      `
      INSERT INTO public.ranch_totals (user_id, eggs, milk, cattle, updated_at)
      VALUES ($1::bigint, 0, 0, 0, NOW())
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );

    await clientDb.query(
      `
      UPDATE public.ranch_totals
      SET ${item} = ${item} + $2,
          updated_at = NOW()
      WHERE user_id = $1::bigint
      `,
      [userId, amount]
    );

    await clientDb.query("COMMIT");
    console.log(`✅ Stored ${item} +${amount} for ${userId}`);
    return true;
  } catch (err) {
    await clientDb.query("ROLLBACK");
    console.error("❌ DB transaction failed:", err);
    return false;
  } finally {
    clientDb.release();
  }
}

// ---------- STATIC LEADERBOARD MESSAGE ----------
async function ensureLeaderboardMessage() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });

  const existing = messages.find((m) => m.author.id === client.user.id);

  if (existing) {
    leaderboardMessageId = existing.id;
  } else {
    const msg = await channel.send("🏆 Beaver Farms — Weekly Ledger\nLoading...");
    leaderboardMessageId = msg.id;
  }
}

async function scheduleLeaderboardUpdate(immediate = false) {
  if (immediate) {
    await updateLeaderboardMessage();
    return;
  }

  updateQueued = true;
  if (updateTimer) return;

  updateTimer = setTimeout(async () => {
    updateTimer = null;
    if (!updateQueued) return;
    updateQueued = false;
    await updateLeaderboardMessage();
  }, LEADERBOARD_DEBOUNCE_MS);
}

async function updateLeaderboardMessage() {
  if (!leaderboardMessageId) return;

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(leaderboardMessageId);

  const { rows } = await pool.query(
    `
    SELECT user_id, eggs, milk, cattle
    FROM public.ranch_totals
    WHERE eggs > 0 OR milk > 0 OR cattle > 0
    `
  );

  const entries = rows.map((r) => {
    const eggs = Number(r.eggs);
    const milk = Number(r.milk);
    const cattle = Number(r.cattle);
    const payout = eggs * PRICES.eggs + milk * PRICES.milk + cattle * PRICES.cattle;
    return { userId: r.user_id.toString(), eggs, milk, cattle, payout };
  });

  entries.sort((a, b) => b.payout - a.payout);

  let output = "🏆 **Beaver Farms — Weekly Ledger**\n\n";
  let ranchTotal = 0;

  for (const e of entries) {
    const user = await client.users.fetch(e.userId).catch(() => null);
    const name = user ? user.username : e.userId;

    ranchTotal += e.payout;

    output +=
      `**${name}**\n` +
      `🥚 Eggs: ${e.eggs}\n` +
      `🥛 Milk: ${e.milk}\n` +
      `🐄 Cattle: ${e.cattle}\n` +
      `💰 **$${e.payout.toFixed(2)}**\n\n`;
  }

  output += `---\n💼 **Total Ranch Payroll:** $${ranchTotal.toFixed(2)}`;

  await message.edit(output);
  console.log("📊 Leaderboard updated");
}

// ---------- GRACEFUL SHUTDOWN (prevents weird Railway kills) ----------
async function shutdown(signal) {
  console.log(`🛑 Received ${signal}. Shutting down gracefully...`);
  try {
    await client.destroy().catch(() => {});
    await pool.end().catch(() => {});
    server.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });

    // hard-exit safety after 10s
    setTimeout(() => process.exit(0), 10000).unref();
  } catch (e) {
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------- LOGIN ----------
client.login(process.env.BOT_TOKEN);
