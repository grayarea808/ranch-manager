// index.js
import express from "express";
import { Pool } from "pg";
import dotenv from "dotenv";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

dotenv.config();

// -----------------------------
// PostgreSQL Setup
// -----------------------------
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

await pool.connect();
console.log("Postgres connected");

// -----------------------------
// Discord Setup
// -----------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(process.env.DISCORD_TOKEN);
console.log(`Logged in as ${client.user.tag}`);

// -----------------------------
// Express Webhook Server
// -----------------------------
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

app.post("/webhook/ranch", async (req, res) => {
  try {
    const { username, milk = 0, eggs = 0, cattle = 0 } = parseWebhook(req.body);

    // Insert or update user in ranch_stats
    await pool.query(
      `
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle
    `,
      [username, milk, eggs, cattle]
    );

    console.log("Webhook received!", req.body);
    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// -----------------------------
// Helper Functions
// -----------------------------

function parseWebhook(payload) {
  // Adjust this based on your game payload
  const userString = payload.username || payload.user || "UNKNOWN";
  const numbers = userString.match(/\d+/g) || [];
  const username = `<@${numbers[0] || "0"}> ${userString.replace(/\d+/g, "").trim()}`;

  let milk = 0, eggs = 0, cattle = 0;

  if (payload.embeds?.[0]?.description) {
    const desc = payload.embeds[0].description;
    const milkMatch = desc.match(/Milk.*?:\s*(\d+)/i);
    const eggsMatch = desc.match(/Eggs.*?:\s*(\d+)/i);
    const cattleMatch = desc.match(/Cattle.*?:\s*(\d+)/i);

    milk = milkMatch ? parseInt(milkMatch[1], 10) : 0;
    eggs = eggsMatch ? parseInt(eggsMatch[1], 10) : 0;
    cattle = cattleMatch ? parseInt(cattleMatch[1], 10) : 0;
  }

  return { username, milk, eggs, cattle };
}

async function updateLeaderboard() {
  try {
    // Weekly reset check
    await resetLeaderboardIfNeeded();

    const { rows } = await pool.query(`
      SELECT username, milk, eggs, cattle,
      (milk*1.25 + eggs*1.25 + cattle*160) AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle("🏆 Beaver Farms — Leaderboard")
      .setColor(0xffd700)
      .setDescription(
        rows.map(r => 
          `${r.username}\n🥛 Milk: ${r.milk}\n🥚 Eggs: ${r.eggs}\n🐄 Cattle: ${r.cattle}\n💰 Total: $${r.total.toFixed(2)}`
        ).join("\n\n")
      );

    // Delete previous leaderboard messages
    const messages = await channel.messages.fetch({ limit: 50 });
    const old = messages.filter(m => m.embeds?.[0]?.title === "🏆 Beaver Farms — Leaderboard");
    for (const m of old.values()) await m.delete();

    await channel.send({ embeds: [embed] });
    console.log("Leaderboard updated!");
  } catch (err) {
    console.error("Error updating leaderboard:", err);
  }
}

// Weekly reset
async function resetLeaderboardIfNeeded() {
  const { rows } = await pool.query(`SELECT last_reset FROM leaderboard_reset LIMIT 1`);
  const now = new Date();
  if (!rows.length || new Date(rows[0].last_reset) <= new Date(now.getTime() - 7*24*60*60*1000)) {
    await pool.query(`UPDATE ranch_stats SET milk=0, eggs=0, cattle=0`);
    await pool.query(`
      INSERT INTO leaderboard_reset(last_reset)
      VALUES($1)
      ON CONFLICT (id)
      DO UPDATE SET last_reset = EXCLUDED.last_reset
    `, [now.toISOString()]);
    console.log("Leaderboard reset for new week");
  }
}
