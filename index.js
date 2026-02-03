import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import pg from "pg";

import {
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

const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID; // log channel
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID; // static leaderboard channel
const HERD_CHANNEL_ID = process.env.HERD_CHANNEL_ID; // herding queue channel

const DEBUG = process.env.DEBUG === "true";

const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 3000);

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 5000);
const BACKFILL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

const PRICES = { eggs: 1.25, milk: 1.25 };
const CATTLE_DEDUCTION = {
  bison: Number(process.env.CATTLE_BISON_DEDUCTION || 400),
  default: Number(process.env.CATTLE_DEFAULT_DEDUCTION || 300),
};

const HERD_REQUIRED_RUNS = Number(process.env.HERD_REQUIRED_RUNS || 4);
const HERD_COOLDOWN_MINUTES = Number(process.env.HERD_COOLDOWN_MINUTES || 15);
const HERD_STALE_HOURS = Number(process.env.HERD_STALE_HOURS || 2);

// =========================
// CRASH LOGGING
// =========================
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// =========================
// POSTGRES
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// =========================
// EXPRESS (Railway keep-alive)
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

// Static message IDs (stored in DB table bot_messages)
let leaderboardMessageId = null;
let herdMessageId = null;

// Leaderboard debounce
let lbTimer = null;
let lbQueued = false;

// Herd message debounce (optional small debounce)
let herdTimer = null;
let herdQueued = false;

// =========================
// READY
// =========================
client.once("ready", async () => {
  try {
    console.log(`🚜 Ranch Manager online as ${client.user.tag}`);
    await pool.query("SELECT 1");
    console.log("✅ DB OK");

    // Ensure static messages exist
    leaderboardMessageId = await ensureBotMessage("leaderboard", LEADERBOARD_CHANNEL_ID, "🏆 Beaver Farms — Weekly Ledger\nLoading...");
    herdMessageId = await ensureBotMessage("herd_queue", HERD_CHANNEL_ID, "🐎 Herding Queue\nLoading...");

    // Backfill ranch logs so missed cattle sales are recovered
    if (BACKFILL_ON_START) {
      console.log(`📥 Backfill on start: scanning up to ${BACKFILL_MAX_MESSAGES} messages...`);
      await backfillFromChannelHistory(BACKFILL_MAX_MESSAGES);
    }

    // Initial renders
    await scheduleLeaderboardUpdate(true);
    await scheduleHerdUpdate(true);

    // Periodic backfill (catch missed events)
    setInterval(async () => {
      try {
        await backfillFromChannelHistory(300);
        await scheduleLeaderboardUpdate(true);
      } catch (e) {
        console.error("❌ Periodic backfill failed:", e);
      }
    }, BACKFILL_EVERY_MS);

    console.log("✅ Startup complete.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

// =========================
// UTIL: ensure static message (stored in DB)
// =========================
async function ensureBotMessage(key, channelId, initialText) {
  if (!channelId) throw new Error(`Missing channelId for ${key}`);

  // Check DB for stored message
  const { rows } = await pool.query(
    `SELECT message_id FROM public.bot_messages WHERE key = $1 LIMIT 1`,
    [key]
  );

  const channel = await client.channels.fetch(channelId);

  // If stored, verify it still exists
  if (rows.length) {
    const msgId = rows[0].message_id.toString();
    try {
      await channel.messages.fetch(msgId);
      return msgId;
    } catch {
      // message missing; fall through to recreate
    }
  }

  // Create new message
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
// RANCH LOG LISTENER
// =========================
client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== INPUT_CHANNEL_ID) return;

    const isWebhookOrBot = Boolean(message.webhookId) || Boolean(message.author?.bot);
    if (!isWebhookOrBot) return;

    if (DEBUG) {
      console.log("INCOMING LOG:", {
        id: message.id,
        content: message.content,
        webhookId: message.webhookId,
        embeds: message.embeds?.map((e) => ({ title: e.title, description: e.description })),
      });
    }

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

// =========================
// PARSE RANCH MESSAGE (embeds + content)
// Supports:
// - Eggs/Milk Added (": 22")
// - Cattle Sale: sold X Bison for 864.0$ (net = sale - deduction)
// =========================
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

  // Eggs/Milk add pattern
  const addedMatch = text.match(/:\s*(\d+)\s*$/m);
  const qty = addedMatch ? Number(addedMatch[1]) : 0;

  if (/Eggs Added|Added Eggs/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "eggs", amount: qty };
  }

  if (/Milk Added|Added Milk/i.test(text) && qty > 0) {
    return { userId, ranchId, item: "milk", amount: qty };
  }

  // Cattle sale pattern: "... sold 4 Bison for 864.0$"
  // We credit NET dollars: sale - deduction
  const saleMatch = text.match(/for\s+([\d.]+)\$/i);
  if (saleMatch) {
    const saleValue = Number(saleMatch[1]);
    if (!Number.isFinite(saleValue) || saleValue <= 0) return null;

    const isBison = /bison/i.test(text);
    const deduction = isBison ? CATTLE_DEDUCTION.bison : CATTLE_DEDUCTION.default;
    const net = Math.max(0, saleValue - deduction);

    return { userId, ranchId, item: "cattle", amount: net };
  }

  return null;
}

// =========================
// DB: Insert event (dedupe by discord_message_id) + update totals
// eggs/milk: amount is unit count (int-ish)
// cattle: amount is net dollars (numeric)
// =========================
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
    console.error("❌ DB transaction failed:", e);
    return false;
  } finally {
    c.release();
  }
}

// =========================
// Backfill ranch logs (safe; dedupe prevents double-count)
// =========================
async function backfillFromChannelHistory(max) {
  const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
  let lastId = null;
  let scanned = 0;
  let inserted = 0;

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

      const ok = await storeEventAndUpdateTotals({ discordMessageId: msg.id, ...parsed });
      if (ok) inserted++;
    }

    lastId = sorted[0].id; // go older
  }

  if (inserted > 0 || DEBUG) {
    console.log(`📥 Backfill scanned ${scanned}, inserted ${inserted}`);
  }
}

// =========================
// LEADERBOARD (sorted highest payout first)
// =========================
async function scheduleLeaderboardUpdate(immediate = false) {
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
  if (!leaderboardMessageId) return;

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const msg = await channel.messages.fetch(leaderboardMessageId);

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
    const cattleNet = Number(r.cattle);
    const payout = eggs * PRICES.eggs + milk * PRICES.milk + cattleNet;
    return { userId: r.user_id.toString(), eggs, milk, cattleNet, payout };
  });

  // COMPETITIVE SORT: highest grossing first
  entries.sort((a, b) => b.payout - a.payout);

  let total = 0;
  let out = "🏆 **Beaver Farms — Weekly Ledger (Top Earners)**\n\n";

  for (const e of entries) {
    total += e.payout;

    const user = await client.users.fetch(e.userId).catch(() => null);
    const name = user ? user.username : e.userId;

    out +=
      `**${name}**\n` +
      `🥚 Eggs: ${e.eggs}\n` +
      `🥛 Milk: ${e.milk}\n` +
      `🐄 Cattle Net: $${e.cattleNet.toFixed(2)}\n` +
      `💰 **$${e.payout.toFixed(2)}**\n\n`;
  }

  out += `---\n💼 **Total Ranch Payroll:** $${total.toFixed(2)}`;

  await msg.edit(out);
}

// =========================
// HERDING QUEUE BUTTONS
// Mode A: same person does all 4 runs
// Rules:
// - Only 1 active herder at a time
// - Cooldown 15 min after each run
// - Progress: 0/4 -> 4/4 READY TO SELL
// - If inactive 2 hours, takeover allowed
// =========================
function now() { return new Date(); }
function addMinutes(d, m) { return new Date(d.getTime() + m * 60000); }
function addHours(d, h) { return new Date(d.getTime() + h * 3600000); }
function toUnix(d) { return Math.floor(d.getTime() / 1000); }
function fmtRel(d) { return `<t:${toUnix(d)}:R>`; }

async function getHerdState() {
  const { rows } = await pool.query(`SELECT * FROM public.herd_state WHERE id = 1 LIMIT 1`);
  return rows[0];
}

async function setHerdState(patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;

  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const vals = keys.map((k) => patch[k]);

  await pool.query(`UPDATE public.herd_state SET ${sets} WHERE id = 1`, vals);
}

async function getQueue() {
  const { rows } = await pool.query(
    `SELECT user_id, joined_at FROM public.herd_queue ORDER BY joined_at ASC`
  );
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

function buildHerdButtons(canTakeOver) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("herd_join").setLabel("Reserve Slot (Join Queue)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("herd_leave").setLabel("Leave Queue").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("herd_start").setLabel("Start Herding").setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("herd_done").setLabel("Mark 1 Herd Done").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("herd_sold").setLabel("Mark Sold (Reset 0/4)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("herd_end").setLabel("End Session").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("herd_takeover").setLabel("Take Over (2h rule)").setStyle(ButtonStyle.Danger).setDisabled(!canTakeOver),
  );

  return [row1, row2];
}

async function scheduleHerdUpdate(immediate = false) {
  if (immediate) return updateHerdMessage();

  herdQueued = true;
  if (herdTimer) return;

  herdTimer = setTimeout(async () => {
    herdTimer = null;
    if (!herdQueued) return;
    herdQueued = false;
    await updateHerdMessage();
  }, 1200);
}

async function updateHerdMessage() {
  if (!herdMessageId) return;

  const channel = await client.channels.fetch(HERD_CHANNEL_ID);
  const msg = await channel.messages.fetch(herdMessageId);

  const state = await getHerdState();
  const queue = await getQueue();

  const activeUserId = state.active_user_id ? state.active_user_id.toString() : null;
  const startedAt = state.active_started_at ? new Date(state.active_started_at) : null;
  const lastActionAt = state.active_last_action_at ? new Date(state.active_last_action_at) : null;
  const cooldownUntil = state.active_cooldown_until ? new Date(state.active_cooldown_until) : null;
  const progress = Number(state.active_progress || 0);

  const stale = activeUserId && lastActionAt && now().getTime() >= addHours(lastActionAt, HERD_STALE_HOURS).getTime();
  const canTakeOver = Boolean(stale);

  let out = "🐎 **Beaver Farms — Herding Queue**\n\n";
  out += `**Rules:** 1 active herder • ${HERD_COOLDOWN_MINUTES}m cooldown per run • ${HERD_REQUIRED_RUNS} runs to sell • stale after ${HERD_STALE_HOURS}h\n\n`;

  if (!activeUserId) {
    out += `**Current Herder:** _None_ ✅\n`;
    out += `**Status:** Herding is available.\n\n`;
  } else {
    out += `**Current Herder:** <@${activeUserId}>\n`;
    if (startedAt) out += `**Started:** ${fmtRel(startedAt)}\n`;
    if (lastActionAt) out += `**Last action:** ${fmtRel(lastActionAt)}\n`;

    if (stale) {
      out += `**Status:** ⚠️ **STALE** (inactive > ${HERD_STALE_HOURS}h) — takeover allowed.\n`;
    } else {
      out += `**Status:** Active\n`;
    }

    out += `**Progress:** ${progress}/${HERD_REQUIRED_RUNS} ${progress >= HERD_REQUIRED_RUNS ? "✅ **READY TO SELL**" : ""}\n`;

    if (cooldownUntil && now().getTime() < cooldownUntil.getTime()) {
      out += `**Cooldown:** ends ${fmtRel(cooldownUntil)}\n`;
    } else {
      out += `**Cooldown:** none\n`;
    }

    out += "\n";
  }

  out += "**Queue:**\n";
  if (!queue.length) {
    out += "_No one in queue._\n";
  } else {
    queue.slice(0, 15).forEach((q, i) => {
      out += `${i + 1}. <@${q.userId}>\n`;
    });
    if (queue.length > 15) out += `…and ${queue.length - 15} more\n`;
  }

  await msg.edit({
    content: out,
    components: buildHerdButtons(canTakeOver),
  });
}

// =========================
// BUTTON INTERACTIONS
// =========================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!HERD_CHANNEL_ID) return;

  // Only respond in the herd channel
  if (interaction.channelId !== HERD_CHANNEL_ID) {
    return interaction.reply({ content: "Use the herding buttons in the herding channel.", ephemeral: true });
  }

  const userId = interaction.user.id;

  try {
    const state = await getHerdState();
    const queue = await getQueue();

    const activeUserId = state.active_user_id ? state.active_user_id.toString() : null;
    const lastActionAt = state.active_last_action_at ? new Date(state.active_last_action_at) : null;
    const cooldownUntil = state.active_cooldown_until ? new Date(state.active_cooldown_until) : null;
    const progress = Number(state.active_progress || 0);

    const stale = activeUserId && lastActionAt && now().getTime() >= addHours(lastActionAt, HERD_STALE_HOURS).getTime();

    const isQueued = queue.some((q) => q.userId === userId);
    const isFirst = queue.length > 0 && queue[0].userId === userId;
    const isActive = activeUserId === userId;

    // ---- JOIN QUEUE
    if (interaction.customId === "herd_join") {
      if (isActive) return interaction.reply({ content: "You’re already the active herder.", ephemeral: true });
      if (isQueued) return interaction.reply({ content: "You’re already in the queue.", ephemeral: true });

      await queueAdd(userId);
      await scheduleHerdUpdate(true);
      return interaction.reply({ content: "✅ You joined the herding queue.", ephemeral: true });
    }

    // ---- LEAVE QUEUE
    if (interaction.customId === "herd_leave") {
      if (!isQueued) return interaction.reply({ content: "You’re not in the queue.", ephemeral: true });
      await queueRemove(userId);
      await scheduleHerdUpdate(true);
      return interaction.reply({ content: "✅ You left the queue.", ephemeral: true });
    }

    // ---- START HERDING (must be first in queue, and no active herder OR active stale)
    if (interaction.customId === "herd_start") {
      if (activeUserId && !stale) {
        return interaction.reply({ content: "Someone is already herding right now.", ephemeral: true });
      }
      if (!isFirst) {
        return interaction.reply({ content: "You can only start if you’re #1 in the queue.", ephemeral: true });
      }

      // Remove from queue + set as active
      await queueRemove(userId);
      await setHerdState({
        active_user_id: userId,
        active_started_at: now(),
        active_last_action_at: now(),
        active_progress: 0,
        active_cooldown_until: null,
      });

      await scheduleHerdUpdate(true);
      return interaction.reply({ content: "🐎 You’re now the active herder. Good luck!", ephemeral: true });
    }

    // ---- MARK 1 HERD DONE (active only + cooldown check + progress < required)
    if (interaction.customId === "herd_done") {
      if (!isActive) return interaction.reply({ content: "Only the active herder can do that.", ephemeral: true });

      if (cooldownUntil && now().getTime() < cooldownUntil.getTime()) {
        return interaction.reply({ content: `Cooldown active. Ends ${fmtRel(cooldownUntil)}.`, ephemeral: true });
      }

      if (progress >= HERD_REQUIRED_RUNS) {
        return interaction.reply({ content: "You’re already at 4/4 — ready to sell. Use **Mark Sold**.", ephemeral: true });
      }

      const newProgress = Math.min(HERD_REQUIRED_RUNS, progress + 1);
      const cd = addMinutes(now(), HERD_COOLDOWN_MINUTES);

      await setHerdState({
        active_last_action_at: now(),
        active_progress: newProgress,
        active_cooldown_until: cd,
      });

      await scheduleHerdUpdate(true);
      return interaction.reply({ content: `✅ Herd run recorded: ${newProgress}/${HERD_REQUIRED_RUNS}. Cooldown started.`, ephemeral: true });
    }

    // ---- MARK SOLD (active only + requires 4/4)
    if (interaction.customId === "herd_sold") {
      if (!isActive) return interaction.reply({ content: "Only the active herder can do that.", ephemeral: true });

      if (progress < HERD_REQUIRED_RUNS) {
        return interaction.reply({ content: `You need ${HERD_REQUIRED_RUNS}/${HERD_REQUIRED_RUNS} before selling.`, ephemeral: true });
      }

      // Reset progress for next cycle; keep the same herder active (Mode A)
      const cd = addMinutes(now(), HERD_COOLDOWN_MINUTES);

      await setHerdState({
        active_last_action_at: now(),
        active_progress: 0,
        active_cooldown_until: cd,
      });

      await scheduleHerdUpdate(true);
      return interaction.reply({ content: "🏁 Sold recorded. Progress reset to 0/4. Cooldown started.", ephemeral: true });
    }

    // ---- END SESSION (active only)
    if (interaction.customId === "herd_end") {
      if (!isActive) return interaction.reply({ content: "Only the active herder can end the session.", ephemeral: true });

      await setHerdState({
        active_user_id: null,
        active_started_at: null,
        active_last_action_at: null,
        active_progress: 0,
        active_cooldown_until: null,
      });

      await scheduleHerdUpdate(true);
      return interaction.reply({ content: "✅ Herding session ended. Herding is now available for the next person.", ephemeral: true });
    }

    // ---- TAKEOVER (only if stale)
    if (interaction.customId === "herd_takeover") {
      if (!activeUserId || !stale) {
        return interaction.reply({ content: "Takeover is only allowed if the herd is stale (inactive for 2 hours).", ephemeral: true });
      }

      // takeover ignores queue fairness (rule says free to be taken)
      // remove taker from queue if present
      await queueRemove(userId);

      await setHerdState({
        active_user_id: userId,
        active_started_at: now(),
        active_last_action_at: now(),
        active_progress: 0,
        active_cooldown_until: null,
      });

      await scheduleHerdUpdate(true);
      return interaction.reply({ content: "⚠️ Takeover successful. You are now the active herder.", ephemeral: true });
    }

    return interaction.reply({ content: "Unknown action.", ephemeral: true });
  } catch (e) {
    console.error("❌ interaction failed:", e);
    try {
      if (!interaction.replied) {
        return interaction.reply({ content: "Error processing that. Try again.", ephemeral: true });
      }
    } catch {}
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
