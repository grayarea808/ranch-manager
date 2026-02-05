import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} from "discord.js";

dotenv.config();
const { Pool } = pg;

const PORT = process.env.PORT || 8080;
const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.get("/", (_, res) => res.send("Camp Tracker Running"));
app.listen(PORT, "0.0.0.0");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Delivery values
const DELIVERY_VALUES = {
  small: 500,
  medium: 950,
  large: 1500
};

const CAMP_CUT = 0.30;

// =========================
// READY
// =========================
let campMessageId = null;

client.once("ready", async () => {
  console.log(`🏕️ Camp Manager Online: ${client.user.tag}`);
  campMessageId = await ensureMessage();
  await updateCampBoard();
});

// =========================
// STATIC MESSAGE
// =========================
async function ensureMessage() {
  const { rows } = await pool.query(
    "SELECT message_id FROM bot_messages WHERE key='camp_board'"
  );

  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);

  if (rows.length) {
    try {
      await channel.messages.fetch(rows[0].message_id);
      return rows[0].message_id;
    } catch {}
  }

  const msg = await channel.send("🏕️ Baba Yaga Camp\nLoading...");
  await pool.query(
    `INSERT INTO bot_messages (key, channel_id, message_id)
     VALUES ('camp_board',$1,$2)
     ON CONFLICT (key) DO UPDATE
     SET message_id=$2`,
    [CAMP_OUTPUT_CHANNEL_ID, msg.id]
  );

  return msg.id;
}

// =========================
// MESSAGE PARSER
// =========================
client.on("messageCreate", async (message) => {
  if (message.channel.id !== CAMP_INPUT_CHANNEL_ID) return;
  if (!message.webhookId && !message.author?.bot) return;

  const parsed = parseMessage(message);
  if (!parsed) return;

  const inserted = await storeEvent(parsed, message.id);
  if (inserted) await updateCampBoard();
});

function parseMessage(message) {
  const text = message.content;

  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;

  const userId = userMatch[1];

  if (/material sets/i.test(text)) {
    const amt = Number(text.match(/(\d+)/)?.[1] || 0);
    return { userId, item: "materials", amount: amt };
  }

  if (/supplies/i.test(text)) {
    const amt = Number(text.match(/(\d+)/)?.[1] || 0);
    return { userId, item: "supplies", amount: amt };
  }

  if (/small delivery/i.test(text)) return { userId, item: "small", amount: 1 };
  if (/medium delivery/i.test(text)) return { userId, item: "medium", amount: 1 };
  if (/large delivery/i.test(text)) return { userId, item: "large", amount: 1 };

  return null;
}

// =========================
// STORE EVENT
// =========================
async function storeEvent({ userId, item, amount }, discordMessageId) {
  const result = await pool.query(
    `INSERT INTO camp_events (discord_message_id,user_id,item,amount)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [discordMessageId, userId, item, amount]
  );

  if (!result.rowCount) return false;

  await pool.query(
    `INSERT INTO camp_totals (user_id)
     VALUES ($1)
     ON CONFLICT DO NOTHING`,
    [userId]
  );

  const column =
    item === "materials"
      ? "material_sets"
      : item;

  await pool.query(
    `UPDATE camp_totals
     SET ${column}=${column}+$2,
         updated_at=NOW()
     WHERE user_id=$1`,
    [userId, amount]
  );

  return true;
}

// =========================
// UPDATE CAMP BOARD
// =========================
async function updateCampBoard() {
  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(campMessageId);

  const { rows } = await pool.query("SELECT * FROM camp_totals");

  const players = rows.map(r => {
    const deliveries =
      r.small + r.medium + r.large;

    const points =
      (r.material_sets * 2) +
      (deliveries * 3) +
      (r.supplies * 1);

    return { ...r, deliveries, points };
  });

  const totalPoints = players.reduce((a, p) => a + p.points, 0);

  const totalDeliveryValue =
    players.reduce((a, p) =>
      a +
      (p.small * DELIVERY_VALUES.small) +
      (p.medium * DELIVERY_VALUES.medium) +
      (p.large * DELIVERY_VALUES.large),
    0);

  const playerPool = totalDeliveryValue * (1 - CAMP_CUT);
  const campRevenue = totalDeliveryValue * CAMP_CUT;

  const valuePerPoint = totalPoints > 0
    ? playerPool / totalPoints
    : 0;

  const embed = new EmbedBuilder()
    .setTitle("🏕️ Baba Yaga Camp")
    .setDescription("Payout Mode: Points (30% camp fee)")
    .setColor(0x2b2d31);

  players.sort((a,b) => b.points - a.points);

  for (const p of players) {
    const payout = p.points * valuePerPoint;

    embed.addFields({
      name: `<@${p.user_id}>`,
      value:
        `🪨 Materials: ${p.material_sets}\n` +
        `🚚 Deliveries: ${p.deliveries}\n` +
        `📦 Supplies: ${p.supplies}\n` +
        `⭐ Points: ${p.points}\n` +
        `💰 Payout: $${payout.toFixed(2)}`
    });
  }

  embed.setFooter({
    text: `🧾 Total Delivery Value: $${totalDeliveryValue.toFixed(2)} • 💰 Camp Revenue: $${campRevenue.toFixed(2)}`
  });

  await msg.edit({ embeds: [embed] });
}

client.login(process.env.BOT_TOKEN);
