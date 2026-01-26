import express from "express";
import bodyParser from "body-parser";
import { Client, GatewayIntentBits } from "discord.js";
import pg from "pg";

const { Pool } = pg;

// ---- DATABASE SETUP ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway Postgres
  ssl: { rejectUnauthorized: false }
});

// ---- DISCORD SETUP ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const DISCORD_CHANNEL_ID = 1465062014626824347; // leaderboard channel
const BOT_TOKEN = process.env.BOT_TOKEN;

client.on("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  updateLeaderboard();
});

client.login(BOT_TOKEN);

// ---- EXPRESS SETUP ----
const app = express();
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  try {
    const { username, eggs = 0, milk = 0, cattle = 0 } = req.body;

    // Check if user exists
    const userResult = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (userResult.rows.length === 0) {
      // New user, insert
      await pool.query(
        "INSERT INTO users(username, eggs, milk, cattle, total) VALUES($1,$2,$3,$4,$5)",
        [username, eggs, milk, cattle, eggs + milk + cattle]
      );
    } else {
      // Existing user, update
      const user = userResult.rows[0];
      const newEggs = user.eggs + eggs;
      const newMilk = user.milk + milk;
      const newCattle = user.cattle + cattle;
      const total = newEggs + newMilk + newCattle;

      await pool.query(
        "UPDATE users SET eggs=$1, milk=$2, cattle=$3, total=$4 WHERE username=$5",
        [newEggs, newMilk, newCattle, total, username]
      );
    }

    // Update Discord leaderboard
    await updateLeaderboard();

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- LEADERBOARD FUNCTION ----
async function updateLeaderboard() {
  try {
    const result = await pool.query(
      "SELECT username, eggs, milk, cattle, total FROM users ORDER BY total DESC"
    );

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel) return;

    let leaderboardText = "🏆 Beaver Farms — Leaderboard\n\n";

    result.rows.forEach((row) => {
      leaderboardText += `${row.username}\n🥛 Milk: ${row.milk}\n🥚 Eggs: ${row.eggs}\n🐄 Cattle: ${row.cattle}\n💰 Total: $${row.total.toFixed(2)}\n\n`;
    });

    await channel.send(leaderboardText);
    console.log("📊 Leaderboard updated");
  } catch (err) {
    console.error("❌ Error updating leaderboard:", err);
  }
}

// ---- WEEKLY RESET ----
function scheduleWeeklyReset() {
  setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 0 && now.getMinutes() === 0) {
      console.log("🔄 Weekly reset triggered");

      try {
        await pool.query("UPDATE users SET eggs=0, milk=0, cattle=0, total=0");
        console.log("✅ All ranch stats reset for the new week");
        await updateLeaderboard();
      } catch (err) {
        console.error("❌ Error during weekly reset:", err);
      }
    }
  }, 60 * 1000);
}

scheduleWeeklyReset();

// ---- START SERVER ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚜 Ranch Manager running on port ${PORT}`);
});


