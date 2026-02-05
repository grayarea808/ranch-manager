import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

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

const HERD_QUEUE_CHANNEL_ID = process.env.HERD_QUEUE_CHANNEL_ID;
if (!HERD_QUEUE_CHANNEL_ID) {
  console.error("❌ Missing Railway variable: HERD_QUEUE_CHANNEL_ID");
  process.exit(1);
}

// optional DB (recommended so queue survives restarts)
const DATABASE_URL = process.env.DATABASE_URL || null;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// ================= EXPRESS (health for Railway) =================
const app = express();
app.get("/", (_, res) => res.status(200).send("Herd Queue running ✅"));
app.get("/health", async (_, res) => {
  try {
    if (pool) await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: !!pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Web listening on ${PORT}`)
);

// ================= DISCORD =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// ================= DB SCHEMA =================
async function ensureSchema() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.herd_queue_state (
      id INT PRIMARY KEY DEFAULT 1,
      active_user_id BIGINT,
      active_started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.herd_queue_entries (
      user_id BIGINT PRIMARY KEY,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ensure singleton row exists
  await pool.query(`
    INSERT INTO public.herd_queue_state (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
}

// ================= QUEUE STATE (memory fallback) =================
let memActiveUserId = null;
let memActiveStartedAt = null;
let memQueue = []; // array of userIds in order

async function loadQueueFromDB() {
  if (!pool) return;

  const state = await pool.query(`SELECT active_user_id, active_started_at FROM public.herd_queue_state WHERE id=1`);
  memActiveUserId = state.rows[0]?.active_user_id ? String(state.rows[0].active_user_id) : null;
  memActiveStartedAt = state.rows[0]?.active_started_at ? new Date(state.rows[0].active_started_at) : null;

  const entries = await pool.query(`SELECT user_id FROM public.herd_queue_entries ORDER BY joined_at ASC`);
  memQueue = entries.rows.map(r => String(r.user_id));
}

async function saveQueueToDB() {
  if (!pool) return;

  await pool.query(
    `UPDATE public.herd_queue_state
     SET active_user_id=$1::bigint, active_started_at=$2, updated_at=NOW()
     WHERE id=1`,
    [
      memActiveUserId ? memActiveUserId : null,
      memActiveStartedAt ? memActiveStartedAt.toISOString() : null,
    ]
  );

  // rewrite entries
  await pool.query(`TRUNCATE public.herd_queue_entries`);
  for (let i = 0; i < memQueue.length; i++) {
    await pool.query(
      `INSERT INTO public.herd_queue_entries (user_id, joined_at) VALUES ($1::bigint, NOW() + ($2 || ' seconds')::interval)`,
      [memQueue[i], i] // preserve order roughly
    );
  }
}

// ================= STATIC MESSAGE =================
async function ensureBotMessage(key, channelId, initialText) {
  if (!pool) {
    // no DB: just send once per boot (not ideal), but workable
    const channel = await client.channels.fetch(channelId);
    const msg = await channel.send(initialText);
    return msg.id;
  }

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

// ================= RENDER =================
const QUEUE_KEY = "herd_queue_board";

function buildQueueEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🐎 Main Herd Queue")
    .setColor(0x2b2d31);

  const active = memActiveUserId ? `<@${memActiveUserId}>` : "None ✅";
  const status = memActiveUserId ? "Status: Herding in progress ⏳" : "Status: Herding is available.";

  let queueText = "No one in queue.";
  if (memQueue.length) {
    queueText = memQueue.map((uid, idx) => `${idx + 1}. <@${uid}>`).join("\n");
  }

  embed.setDescription(
    `Current Herder: ${active}\n` +
    `${status}\n\n` +
    `Queue:\n${queueText}`
  );

  return embed;
}

function buildQueueComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("queue_join")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("queue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("queue_start")
      .setLabel("Start Herding")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("queue_end")
      .setLabel("End Herding")
      .setStyle(ButtonStyle.Danger)
  );

  return [row];
}

async function renderQueueBoard() {
  const channel = await client.channels.fetch(HERD_QUEUE_CHANNEL_ID);
  const msgId = await ensureBotMessage(QUEUE_KEY, HERD_QUEUE_CHANNEL_ID, "Loading herd queue...");

  const msg = await channel.messages.fetch(msgId);
  await msg.edit({
    content: "",
    embeds: [buildQueueEmbed()],
    components: buildQueueComponents(),
  });
}

// ================= HELPERS =================
function isInQueue(userId) {
  return memQueue.includes(userId);
}

function removeFromQueue(userId) {
  memQueue = memQueue.filter((x) => x !== userId);
}

// ================= INTERACTIONS (FIXES “interaction failed”) =================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    // ✅ always acknowledge quickly so Discord doesn't error
    await interaction.deferUpdate();

    const userId = interaction.user.id;

    if (interaction.customId === "queue_join") {
      if (!memActiveUserId) {
        // If no one herding, joining means you become first in queue (not active yet)
      }
      if (!isInQueue(userId) && memActiveUserId !== userId) {
        memQueue.push(userId);
      }
    }

    if (interaction.customId === "queue_leave") {
      if (memActiveUserId === userId) {
        // active herder can't "leave"; they must end session
      } else {
        removeFromQueue(userId);
      }
    }

    if (interaction.customId === "queue_start") {
      // only if no active herder
      if (!memActiveUserId) {
        // only first in queue can start, OR if queue empty you can start directly
        if (memQueue.length === 0) {
          memActiveUserId = userId;
          memActiveStartedAt = new Date();
        } else if (memQueue[0] === userId) {
          memQueue.shift();
          memActiveUserId = userId;
          memActiveStartedAt = new Date();
        }
      }
    }

    if (interaction.customId === "queue_end") {
      // only active herder can end
      if (memActiveUserId === userId) {
        memActiveUserId = null;
        memActiveStartedAt = null;
      }
    }

    // persist + re-render
    await saveQueueToDB();
    await renderQueueBoard();
  } catch (e) {
    console.error("❌ interactionCreate error:", e);
    // If deferUpdate failed, try a safe reply
    try {
      if (interaction.isRepliable() && !interaction.replied) {
        await interaction.reply({ content: "⚠️ Something went wrong. Try again.", ephemeral: true });
      }
    } catch {}
  }
});

// ================= STARTUP =================
client.once("clientReady", async () => {
  try {
    console.log(`🐎 Herd Queue online as ${client.user.tag}`);

    await ensureSchema();
    await loadQueueFromDB();
    await renderQueueBoard();

    console.log("✅ Queue ready.");
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
    if (pool) await pool.end().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  } catch {
    process.exit(1);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

client.login(BOT_TOKEN);
