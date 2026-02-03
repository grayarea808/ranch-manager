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

// Backfill
const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000); // 5 min
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 1000);

// Prices
const PRICES = {
  eggs: 1.25,
  milk: 1.25,
};

// Cattle deductions
const CATTLE_DEDUCTION = {
  bison: Number(process.env.CATTLE_BISON_DEDUCTION || 400),
  default: Number(process.env.CATTLE_DEFAULT_DEDUCTION || 300),
};

// ---------- CRASH LOGGING ----------
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// ---------- POSTGRES ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("Ranch Manager online ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false });
  }
});

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
let updateTimer = null;
let updateQueued = false;

// ---------- READY ----------
client.once("ready", async () => {
  try {
    console.log(`🚜 Ranch Manager online as ${client.user.tag}`);
    await pool.query("SELECT 1");

    await ensureLeaderboardMessage();

    if (BACKFILL_ON_START) {
      console.log("📥 Backfilling history…");
      await backfillFromChannelHistory(BACKFILL_MAX_MESSAGES);
    }

    await scheduleLeaderboardUpdate(true);

    setInterval(async () => {
      await backfillFromChannelHistory(300);
      await scheduleLeaderboardUpdate(true);
    }, BACKFILL_EVERY_MS);

    console.log("✅ Listening for ranch activity");
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
});

// ---------- MESSAGE LISTENER ----------
client.on("messageCreate", async (message) => {
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
});

// ---------- PARSER ----------
function parseRanchMessage(message) {
  let text = (message.content || "").trim();

  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += `\n${e.title}`;
      if (e.description) text += `\n${e.description}`;
      if (e.fields) for (const f of e.fields) text += `\n${f.name}\n${f.value}`;
    }
  }

  text = text.trim();
  if (!text) return null;

  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;
  const userId = BigInt(userMatch[1]).toString();

  const ranchIdMatch = text.match(/Ranch ID:\s*(\d+)/i) || text.match(/ranch id\s*(\d+)/i);
  const ranchId = ranchIdMatch ? Number(ranchIdMatch[1]) : null;

  // Eggs / Milk
  const addedMatch = text.match(/:\s*(\d+)\s*$/m);
  const qty = addedMatch ? Number(addedMatch[1]) : 0;

  if (/Eggs Added|Added Eggs/i.test(text)) return { userId, ranchId, item: "eggs", amount: qty };
  if (/Milk Added|Added Milk/i.test(text)) return { userId, ranchId, item: "milk", amount: qty };

  // Cattle / Bison sales
  const saleMatch = text.match(/for\s+([\d.]+)\$/i);
  if (saleMatch) {
    const saleValue = Number(saleMatch[1]);
    if (!saleValue) return null;

    const isBison = /bison/i.test(text);
    const deduction = isBison ? CATTLE_DEDUCTION.bison : CATTLE_DEDUCTION.default;
    const net = Math.max(0, saleValue - deduction);

    return { userId, ranchId, item: "cattle", amount: net };
  }

  return null;
}

// ---------- DB WRITE ----------
async function storeEventAndUpdateTotals({ discordMessageId, userId, ranchId, item, amount }) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const ins = await c.query(
      `
      INSERT INTO public.ranch_events
        (discord_message_id, user_id, ranch_id, item, amount)
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
    console.error("❌ DB error:", e);
    return false;
  } finally {
    c.release();
  }
}

// ---------- BACKFILL ----------
async function backfillFromChannelHistory(max) {
  const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
  let lastId = null;
  let scanned = 0;

  while (scanned < max) {
    const batch = await channel.messages.fetch(
      lastId ? { limit: 100, before: lastId } : { limit: 100 }
    );
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      scanned++;
      const parsed = parseRanchMessage(msg);
      if (!parsed) continue;

      await storeEventAndUpdateTotals({
        discordMessageId: msg.id,
        ...parsed,
      });
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Backfill scanned ${scanned} messages`);
}

// ---------- LEADERBOARD ----------
async function ensureLeaderboardMessage() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 10 });
  const existing = msgs.find((m) => m.author.id === client.user.id);

  if (existing) leaderboardMessageId = existing.id;
  else leaderboardMessageId = (await channel.send("🏆 Beaver Farms — Weekly Ledger")).id;
}

async function scheduleLeaderboardUpdate(immediate = false) {
  if (immediate) return updateLeaderboardMessage();

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
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(leaderboardMessageId);

  const { rows } = await pool.query(
    `SELECT user_id, eggs, milk, cattle FROM public.ranch_totals`
  );

  let output = "🏆 **Beaver Farms — Weekly Ledger**\n\n";
  let total = 0;

  for (const r of rows) {
    const eggs = Number(r.eggs);
    const milk = Number(r.milk);
    const cattle = Number(r.cattle);
    const payout = eggs * PRICES.eggs + milk * PRICES.milk + cattle;

    if (!payout) continue;

    total += payout;
    const user = await client.users.fetch(r.user_id.toString()).catch(() => null);
    const name = user ? user.username : r.user_id;

    output +=
      `**${name}**\n` +
      `🥚 Eggs: ${eggs}\n` +
      `🥛 Milk: ${milk}\n` +
      `🐄 Cattle Net: $${cattle.toFixed(2)}\n` +
      `💰 **$${payout.toFixed(2)}**\n\n`;
  }

  output += `---\n💼 **Total Ranch Payroll:** $${total.toFixed(2)}`;
  await message.edit(output);
}

// ---------- SHUTDOWN ----------
async function shutdown() {
  await client.destroy().catch(() => {});
  await pool.end().catch(() => {});
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---------- LOGIN ----------
client.login(process.env.BOT_TOKEN);
