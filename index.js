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

const RESET_WEEKLY = (process.env.RESET_WEEKLY || "true") === "true";
const RESET_WEEKDAY = Number(process.env.RESET_WEEKDAY || 0); // 0 = Sunday
const RESET_HOUR = Number(process.env.RESET_HOUR || 0);
const RESET_MINUTE = Number(process.env.RESET_MINUTE || 0);
const RESET_TIMEZONE = process.env.RESET_TIMEZONE || "America/New_York";

const PRICES = {
  eggs: 1.25,
  milk: 1.25,
  cattle: 800,
};

// ---------- POSTGRES ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : undefined,
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
    res.status(500).json({ ok: false, db: false });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Web server listening on port ${PORT}`);
});

// ---------- DISCORD ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // must be enabled in Dev Portal too
  ],
});

// ---------- LEADERBOARD MESSAGE ----------
let leaderboardMessageId = null;

// Debounce state (QoL: prevents rate-limit under spam)
let updateTimer = null;
let updateQueued = false;

// ---------- READY (support both event names) ----------
client.once("ready", () => onClientReady());
client.once("clientReady", () => onClientReady());

async function onClientReady() {
  console.log(`🚜 Ranch Manager online as ${client.user.tag}`);

  if (!INPUT_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID) {
    console.log("❌ Missing INPUT_CHANNEL_ID or LEADERBOARD_CHANNEL_ID in Railway variables");
    return;
  }

  await ensureLeaderboardMessage();
  await scheduleLeaderboardUpdate(true);

  if (RESET_WEEKLY) {
    scheduleWeeklyReset();
  }
}

// ---------- MESSAGE LISTENER ----------
client.on("messageCreate", async (message) => {
  if (message.channel.id !== INPUT_CHANNEL_ID) return;

  // Accept webhook OR bot messages
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

  // Store in DB (dedupe by discord_message_id)
  const stored = await storeEventAndUpdateTotals({
    discordMessageId: message.id,
    ...parsed,
  });

  // If it was a duplicate, don't re-update leaderboard
  if (!stored) return;

  await scheduleLeaderboardUpdate();
});

// ---------- PARSER (embeds + content) ----------
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

  // Mention
  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;
  const userId = BigInt(userMatch[1]).toString();

  // ranch id (optional but useful)
  const ranchIdMatch = text.match(/ranch id\s*(\d+)/i);
  const ranchId = ranchIdMatch ? Number(ranchIdMatch[1]) : null;

  // amount at end like ": 22"
  const amountMatch = text.match(/:\s*(\d+)\s*$/m);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;

  let item = null;

  if (/Eggs Added/i.test(text) || /Added Eggs/i.test(text)) item = "eggs";
  if (/Milk Added/i.test(text) || /Added Milk/i.test(text)) item = "milk";
  if (/Cattle Added/i.test(text) || /Added Cattle/i.test(text)) item = "cattle";

  if (!item || amount <= 0) return null;

  return { userId, ranchId, item, amount };
}

// ---------- DB: insert event + upsert totals ----------
async function storeEventAndUpdateTotals({ discordMessageId, userId, ranchId, item, amount }) {
  const clientDb = await pool.connect();
  try {
    await clientDb.query("BEGIN");

    // Insert event; if duplicate message id, skip
    const insertEvent = await clientDb.query(
      `
      INSERT INTO ranch_events (discord_message_id, user_id, ranch_id, item, amount)
      VALUES ($1, $2::bigint, $3, $4, $5)
      ON CONFLICT (discord_message_id) DO NOTHING
      RETURNING id
      `,
      [discordMessageId, userId, ranchId, item, amount]
    );

    if (insertEvent.rowCount === 0) {
      await clientDb.query("ROLLBACK");
      if (DEBUG) console.log("⏭️ Duplicate event ignored:", discordMessageId);
      return false;
    }

    // Upsert totals
    const col = item; // eggs/milk/cattle
    await clientDb.query(
      `
      INSERT INTO ranch_totals (user_id, eggs, milk, cattle, updated_at)
      VALUES ($1::bigint, 0, 0, 0, NOW())
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );

    await clientDb.query(
      `
      UPDATE ranch_totals
      SET ${col} = ${col} + $2,
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
    console.error("❌ storeEventAndUpdateTotals failed:", err);
    return false;
  } finally {
    clientDb.release();
  }
}

// ---------- LEADERBOARD: debounce edits ----------
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

// ---------- ensure one static message ----------
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

// ---------- Update leaderboard by reading DB totals ----------
async function updateLeaderboardMessage() {
  if (!leaderboardMessageId) return;

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(leaderboardMessageId);

  const { rows } = await pool.query(
    `SELECT user_id, eggs, milk, cattle
     FROM ranch_totals
     WHERE eggs > 0 OR milk > 0 OR cattle > 0`
  );

  const entries = [];

  for (const r of rows) {
    const eggs = Number(r.eggs);
    const milk = Number(r.milk);
    const cattle = Number(r.cattle);

    const payout = eggs * PRICES.eggs + milk * PRICES.milk + cattle * PRICES.cattle;

    entries.push({
      userId: r.user_id.toString(),
      eggs,
      milk,
      cattle,
      payout,
    });
  }

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

// ---------- Weekly reset with archive ----------
function scheduleWeeklyReset() {
  // compute ms until next scheduled reset in RESET_TIMEZONE
  const msUntilNext = msUntilNextWeeklyReset();
  console.log(`🗓️ Weekly reset scheduled in ${(msUntilNext / 1000 / 60).toFixed(1)} minutes`);

  setTimeout(async () => {
    try {
      await archiveAndResetTotals();
    } finally {
      // reschedule next week
      scheduleWeeklyReset();
    }
  }, msUntilNext);
}

function msUntilNextWeeklyReset() {
  // Use Intl to compute local time components in the requested timezone
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RESET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  const weekdayStr = get("weekday"); // Sun/Mon/...
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const localWeekday = weekdayMap[weekdayStr];

  const localYear = Number(get("year"));
  const localMonth = Number(get("month"));
  const localDay = Number(get("day"));

  // Create a Date representing the intended reset time in local tz by stepping day-by-day from today.
  // We'll approximate by computing next occurrence (0-7 days ahead) and then converting to UTC by using Date with UTC components.
  let daysAhead = (RESET_WEEKDAY - localWeekday + 7) % 7;
  if (daysAhead === 0) {
    // if today, only schedule if time is still ahead
    const localHour = Number(get("hour"));
    const localMinute = Number(get("minute"));
    const localSecond = Number(get("second"));
    const alreadyPassed =
      localHour > RESET_HOUR ||
      (localHour === RESET_HOUR && localMinute > RESET_MINUTE) ||
      (localHour === RESET_HOUR && localMinute === RESET_MINUTE && localSecond >= 0);

    if (alreadyPassed) daysAhead = 7;
  }

  // We’ll compute target date in local calendar then estimate by using Date in UTC at same “wall clock” time.
  // This is usually fine for weekly scheduling; DST shifts may move it by an hour around the boundary.
  const targetLocal = new Date(Date.UTC(localYear, localMonth - 1, localDay, RESET_HOUR, RESET_MINUTE, 0));
  targetLocal.setUTCDate(targetLocal.getUTCDate() + daysAhead);

  const ms = targetLocal.getTime() - now.getTime();
  return Math.max(ms, 10_000); // minimum 10s safety
}

async function archiveAndResetTotals() {
  const clientDb = await pool.connect();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  try {
    await clientDb.query("BEGIN");

    const { rows } = await clientDb.query(
      `SELECT user_id, eggs, milk, cattle FROM ranch_totals
       WHERE eggs > 0 OR milk > 0 OR cattle > 0`
    );

    for (const r of rows) {
      const eggs = Number(r.eggs);
      const milk = Number(r.milk);
      const cattle = Number(r.cattle);
      const payout = eggs * PRICES.eggs + milk * PRICES.milk + cattle * PRICES.cattle;

      await clientDb.query(
        `
        INSERT INTO ranch_weekly_payouts
          (period_start, period_end, user_id, eggs, milk, cattle, payout)
        VALUES ($1, $2, $3::bigint, $4, $5, $6, $7)
        `,
        [periodStart, periodEnd, r.user_id.toString(), eggs, milk, cattle, payout.toFixed(2)]
      );
    }

    // Reset totals
    await clientDb.query(
      `UPDATE ranch_totals
       SET eggs = 0, milk = 0, cattle = 0, updated_at = NOW()`
    );

    await clientDb.query("COMMIT");

    console.log("🔄 Weekly payroll archived + reset complete");
    await scheduleLeaderboardUpdate(true);
  } catch (err) {
    await clientDb.query("ROLLBACK");
    console.error("❌ archiveAndResetTotals failed:", err);
  } finally {
    clientDb.release();
  }
}

// ---------- LOGIN ----------
client.login(process.env.BOT_TOKEN);
