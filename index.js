import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let leaderboard = {}; // stores user data

// ---------- Discord Ready ----------
client.once("ready", () => {
  console.log(`🚜 Ranch Manager running as ${client.user.tag}`);
  updateLeaderboardChannel(); // update on startup
  scheduleWeeklyReset(); // start the weekly reset timer
});

// ---------- Webhook ----------
app.post("/webhook", (req, res) => {
  const { username, eggs = 0, milk = 0, cattle = 0 } = req.body;

  if (!username) return res.status(400).send("Username is required");

  if (!leaderboard[username]) {
    leaderboard[username] = { eggs: 0, milk: 0, cattle: 0 };
  }

  leaderboard[username].eggs += eggs;
  leaderboard[username].milk += milk;
  leaderboard[username].cattle += cattle;

  console.log(`✅ Updated ${username}:`, leaderboard[username]);
  updateLeaderboardChannel();

  res.status(200).send("Leaderboard updated");
});

// ---------- Update Discord Leaderboard ----------
async function updateLeaderboardChannel() {
  if (!LEADERBOARD_CHANNEL_ID) return console.log("Leaderboard channel ID missing");

  try {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (!channel) throw new Error("Channel not found");

    let message = "🏆 Beaver Farms — Leaderboard\n\n";

    for (const [user, data] of Object.entries(leaderboard)) {
      const total = data.eggs + data.milk + data.cattle;
      message += `**${user}**\n🥚 Eggs: ${data.eggs}\n🥛 Milk: ${data.milk}\n🐄 Cattle: ${data.cattle}\n💰 Total: $${total}\n\n`;
    }

    await channel.send(message);
    console.log("📊 Leaderboard updated");
  } catch (err) {
    console.error("❌ Error updating leaderboard:", err);
  }
}

// ---------- Weekly Reset ----------
function scheduleWeeklyReset() {
  // Reset every 7 days (in ms)
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  setInterval(() => {
    console.log("🔄 Weekly leaderboard reset");
    leaderboard = {};
    updateLeaderboardChannel();
  }, oneWeek);
}

// ---------- Express Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Webhook running on port ${PORT}`);
});

// ---------- Discord Login ----------
client.login(process.env.BOT_TOKEN);
