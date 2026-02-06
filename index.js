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
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}

const HERD_QUEUE_CHANNEL_ID =
  process.env.HERD_QUEUE_CHANNEL_ID ||
  process.env.HERD_CHANNEL_ID;

if (!HERD_QUEUE_CHANNEL_ID) {
  console.error("❌ Missing HERD_QUEUE_CHANNEL_ID");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL || null;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// ================= EXPRESS =================
const app = express();
app.get("/", (_, res) => res.send("Herd Queue running"));
app.listen(PORT, "0.0.0.0");

// ================= DISCORD =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================= DB =================
async function ensureSchema() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS herd_queue (
      user_id BIGINT PRIMARY KEY,
      joined_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT,
      message_id BIGINT
    );
  `);
}

let memQueue = [];

async function loadQueue() {
  if (!pool) return;
  const { rows } = await pool.query(
    `SELECT user_id FROM herd_queue ORDER BY joined_at ASC`
  );
  memQueue = rows.map(r => String(r.user_id));
}

async function saveQueue() {
  if (!pool) return;
  await pool.query(`TRUNCATE herd_queue`);
  for (let i = 0; i < memQueue.length; i++) {
    await pool.query(
      `INSERT INTO herd_queue (user_id, joined_at)
       VALUES ($1::bigint, NOW() + ($2 || ' seconds')::interval)`,
      [memQueue[i], i]
    );
  }
}

// ================= STATIC MESSAGE =================
async function ensureBoard() {
  if (!pool) {
    const channel = await client.channels.fetch(HERD_QUEUE_CHANNEL_ID);
    const msg = await channel.send("Loading...");
    return msg.id;
  }

  const { rows } = await pool.query(
    `SELECT message_id FROM bot_messages WHERE key='herd_queue'`
  );

  const channel = await client.channels.fetch(HERD_QUEUE_CHANNEL_ID);

  if (rows.length) {
    try {
      await channel.messages.fetch(rows[0].message_id);
      return rows[0].message_id.toString();
    } catch {}
  }

  const msg = await channel.send("Loading...");
  await pool.query(
    `INSERT INTO bot_messages (key, channel_id, message_id)
     VALUES ('herd_queue',$1,$2)
     ON CONFLICT (key)
     DO UPDATE SET message_id=EXCLUDED.message_id`,
    [HERD_QUEUE_CHANNEL_ID, msg.id]
  );

  return msg.id;
}

// ================= RENDER =================
function buildEmbed() {
  const active = memQueue.length ? `<@${memQueue[0]}>` : "None ✅";

  const queueText = memQueue.length
    ? memQueue.map((u, i) => `${i + 1}. <@${u}>`).join("\n")
    : "No one in queue.";

  return new EmbedBuilder()
    .setTitle("🐎 Main Herd Queue")
    .setColor(0x2b2d31)
    .setDescription(
      `Current Herder: ${active}\n` +
      `Status: ${memQueue.length ? "Herding in progress ⏳" : "Herding is available."}\n\n` +
      `Queue:\n${queueText}`
    );
}

function buildButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("join")
        .setLabel("Join Queue")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("leave")
        .setLabel("Leave Queue")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function render() {
  const channel = await client.channels.fetch(HERD_QUEUE_CHANNEL_ID);
  const msgId = await ensureBoard();
  const msg = await channel.messages.fetch(msgId);

  await msg.edit({
    embeds: [buildEmbed()],
    components: buildButtons(),
  });
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  await interaction.deferUpdate(); // prevent "interaction failed"

  const userId = interaction.user.id;

  if (interaction.customId === "join") {
    if (!memQueue.includes(userId)) {
      memQueue.push(userId);
    }
  }

  if (interaction.customId === "leave") {
    memQueue = memQueue.filter(u => u !== userId);
  }

  await saveQueue();
  await render();
});

// ================= START =================
client.once("clientReady", async () => {
  console.log(`🐎 Herd Queue online as ${client.user.tag}`);
  await ensureSchema();
  await loadQueue();
  await render();
});

client.login(BOT_TOKEN);
