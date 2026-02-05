import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import pg from "pg";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

dotenv.config();
const { Pool } = pg;

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 8080;

const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const HERD_CHANNEL_ID = process.env.HERD_CHANNEL_ID;

const PRICES = { eggs: 1.25, milk: 1.25 };

// Herd economy (one payout per completed sale message)
const HERD_ANIMAL_TOTALS = {
  bison: { buy: 300, sell: 1200 },
  deer: { buy: 250, sell: 1000 },
  sheep: { buy: 150, sell: 900 },
};

const RANCH_PROFIT_PER_SALE = 100;

function herdCyclePayout(animalKey) {
  const v = HERD_ANIMAL_TOTALS[animalKey];
  return Math.max(0, (v.sell - v.buy) - RANCH_PROFIT_PER_SALE);
}

// Herd rules
const HERD_REQUIRED_RUNS = 4;
const HERD_COOLDOWN_MINUTES = 15;
const HERD_STALE_HOURS = 2;

// =========================
// DATABASE
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// =========================
// EXPRESS
// =========================
const app = express();
app.get("/", (_, res) => res.send("Ranch Manager Running"));
app.listen(PORT, "0.0.0.0");

// =========================
// DISCORD
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let leaderboardMessageId = null;
let herdMessageId = null;

// =========================
// READY
// =========================
client.once("ready", async () => {
  console.log(`🚜 Ranch Manager Online: ${client.user.tag}`);

  leaderboardMessageId = await ensureStaticMessage(
    "leaderboard",
    LEADERBOARD_CHANNEL_ID,
    "🏆 Beaver Farms — Weekly Ledger\nLoading..."
  );

  herdMessageId = await ensureStaticMessage(
    "herd",
    HERD_CHANNEL_ID,
    "🐎 Beaver Farms — Herding Queue\nLoading..."
  );

  await updateLeaderboard();
  await updateHerdBoard();
});

// =========================
// STATIC MESSAGE HANDLER
// =========================
async function ensureStaticMessage(key, channelId, initialText) {
  const { rows } = await pool.query(
    "SELECT message_id FROM bot_messages WHERE key=$1",
    [key]
  );

  const channel = await client.channels.fetch(channelId);

  if (rows.length) {
    try {
      await channel.messages.fetch(rows[0].message_id);
      return rows[0].message_id;
    } catch {}
  }

  const msg = await channel.send(initialText);

  await pool.query(
    `
    INSERT INTO bot_messages (key, channel_id, message_id)
    VALUES ($1,$2,$3)
    ON CONFLICT (key) DO UPDATE
    SET message_id=$3
    `,
    [key, channelId, msg.id]
  );

  return msg.id;
}

// =========================
// LOG PARSER
// =========================
client.on("messageCreate", async (message) => {
  if (message.channel.id !== INPUT_CHANNEL_ID) return;
  if (!message.webhookId && !message.author?.bot) return;

  const parsed = parseMessage(message);
  if (!parsed) return;

  const inserted = await storeEvent(parsed, message.id);
  if (inserted) await updateLeaderboard();
});

function parseMessage(message) {
  let text = message.content || "";

  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += "\n" + e.title;
      if (e.description) text += "\n" + e.description;
    }
  }

  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;
  const userId = userMatch[1];

  // Eggs
  if (/Eggs Added/i.test(text)) {
    const qty = Number(text.match(/:\s*(\d+)/)?.[1] || 0);
    if (qty > 0) return { userId, item: "eggs", amount: qty };
  }

  // Milk
  if (/Milk Added/i.test(text)) {
    const qty = Number(text.match(/:\s*(\d+)/)?.[1] || 0);
    if (qty > 0) return { userId, item: "milk", amount: qty };
  }

  // Herd Sale (one payout per message)
  if (/sold/i.test(text)) {
    const lower = text.toLowerCase();
    let animal = null;

    if (lower.includes("bison")) animal = "bison";
    else if (lower.includes("deer")) animal = "deer";
    else if (lower.includes("sheep")) animal = "sheep";

    if (!animal) return null;

    const payout = herdCyclePayout(animal);
    return { userId, item: "cattle", amount: payout };
  }

  return null;
}

// =========================
// STORE EVENT
// =========================
async function storeEvent({ userId, item, amount }, discordMessageId) {
  const result = await pool.query(
    `
    INSERT INTO ranch_events (discord_message_id,user_id,item,amount)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (discord_message_id) DO NOTHING
    RETURNING id
    `,
    [discordMessageId, userId, item, amount]
  );

  if (!result.rowCount) return false;

  await pool.query(
    `
    INSERT INTO ranch_totals (user_id, eggs, milk, cattle)
    VALUES ($1,0,0,0)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  await pool.query(
    `UPDATE ranch_totals
     SET ${item}=${item}+$2
     WHERE user_id=$1`,
    [userId, amount]
  );

  return true;
}

// =========================
// LEADERBOARD (sorted SQL)
// =========================
async function updateLeaderboard() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const msg = await channel.messages.fetch(leaderboardMessageId);

  const { rows } = await pool.query(
    `
    SELECT user_id, eggs, milk, cattle,
    (eggs*1.25 + milk*1.25 + cattle) AS payout
    FROM ranch_totals
    WHERE eggs>0 OR milk>0 OR cattle>0
    ORDER BY payout DESC
    `
  );

  let output = "🏆 **Beaver Farms — Weekly Ledger (Top Earners)**\n\n";
  let rank = 1;
  const medals = ["🥇", "🥈", "🥉"];

  for (const r of rows) {
    const badge = medals[rank - 1] || `#${rank}`;
    const user = await client.users.fetch(r.user_id).catch(() => null);
    const name = user ? user.username : r.user_id;

    output +=
      `**${badge} ${name}**\n` +
      `🥚 ${r.eggs} | 🥛 ${r.milk} | 🐄 $${Number(r.cattle).toFixed(2)}\n` +
      `💰 **$${Number(r.payout).toFixed(2)}**\n\n`;

    rank++;
  }

  await msg.edit(output);
}

// =========================
// HERD QUEUE (STATIC ONLY)
// =========================
function now() { return new Date(); }
function addMinutes(d, m) { return new Date(d.getTime() + m * 60000); }
function addHours(d, h) { return new Date(d.getTime() + h * 3600000); }
function toUnix(d) { return Math.floor(d.getTime() / 1000); }
function rel(d) { return `<t:${toUnix(d)}:R>`; }

async function updateHerdBoard() {
  const channel = await client.channels.fetch(HERD_CHANNEL_ID);
  const msg = await channel.messages.fetch(herdMessageId);

  const { rows: [state] } = await pool.query(`SELECT * FROM herd_state WHERE id=1`);
  const { rows: queue } = await pool.query(`SELECT user_id FROM herd_queue ORDER BY joined_at ASC`);

  let output = "🐎 **Beaver Farms — Herding Queue**\n\n";
  output += "Rules: 1 active herder • 15m cooldown • 4 runs to sell • stale after 2h\n\n";

  if (!state.active_user_id) {
    output += "Current Herder: None ✅\nStatus: Herding is available.\n\n";
  } else {
    output += `Current Herder: <@${state.active_user_id}>\n`;
    output += `Progress: ${state.active_progress}/4\n`;
    if (state.active_cooldown_until && now() < state.active_cooldown_until)
      output += `Cooldown: ends ${rel(state.active_cooldown_until)}\n`;
    output += "\n";
  }

  output += "Queue:\n";
  if (!queue.length) output += "No one in queue.";
  else queue.forEach((q, i) => output += `${i + 1}. <@${q.user_id}>\n`);

  await msg.edit({
    content: output,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("join").setLabel("Join Queue").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("leave").setLabel("Leave Queue").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("start").setLabel("Start").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("done").setLabel("Mark Done").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("end").setLabel("End").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

// =========================
// BUTTON HANDLER (NO SPAM)
// =========================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  await interaction.deferUpdate(); // silent

  const userId = interaction.user.id;

  if (interaction.customId === "join") {
    await pool.query(
      `INSERT INTO herd_queue (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  }

  if (interaction.customId === "leave") {
    await pool.query(`DELETE FROM herd_queue WHERE user_id=$1`, [userId]);
  }

  if (interaction.customId === "start") {
    const { rows } = await pool.query(`SELECT * FROM herd_state WHERE id=1`);
    if (!rows[0].active_user_id) {
      await pool.query(
        `UPDATE herd_state SET active_user_id=$1, active_progress=0 WHERE id=1`,
        [userId]
      );
      await pool.query(`DELETE FROM herd_queue WHERE user_id=$1`, [userId]);
    }
  }

  if (interaction.customId === "done") {
    await pool.query(
      `UPDATE herd_state
       SET active_progress=active_progress+1,
           active_cooldown_until=NOW() + INTERVAL '15 minutes'
       WHERE id=1 AND active_user_id=$1`,
      [userId]
    );
  }

  if (interaction.customId === "end") {
    await pool.query(
      `UPDATE herd_state
       SET active_user_id=NULL, active_progress=0, active_cooldown_until=NULL
       WHERE id=1`
    );
  }

  await updateHerdBoard();
});

client.login(process.env.BOT_TOKEN);
