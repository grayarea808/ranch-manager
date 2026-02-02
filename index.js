import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;

const PRICES = {
  eggs: 1.25,
  milk: 1.25,
  cattle: 800,
};

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- IN-MEMORY DB ----------
let leaderboard = {};
let leaderboardMessageId = null;

// ---------- BOT READY ----------
client.once("ready", async () => {
  console.log(`🚜 Ranch Manager online as ${client.user.tag}`);
  await ensureLeaderboardMessage();
  scheduleWeeklyReset();
});

// ---------- MESSAGE LISTENER ----------
client.on("messageCreate", async (message) => {
  if (message.channel.id !== INPUT_CHANNEL_ID) return;
  if (!message.author.bot) return;

  const parsed = parseRanchMessage(message);
  if (!parsed) return;

  const { userId, eggs, milk, cattle } = parsed;

  if (!leaderboard[userId]) {
    leaderboard[userId] = { eggs: 0, milk: 0, cattle: 0 };
  }

  leaderboard[userId].eggs += eggs;
  leaderboard[userId].milk += milk;
  leaderboard[userId].cattle += cattle;

  console.log(`✅ Logged for ${userId}`, leaderboard[userId]);

  await updateLeaderboardMessage();
});

// ---------- PARSER (YOUR FORMAT) ----------
function parseRanchMessage(message) {
  const content = message.content;

  // Grab mentioned user ID
  const userMatch = content.match(/<@(\d+)>/);
  if (!userMatch) return null;

  const userId = userMatch[1];

  let eggs = 0;
  let milk = 0;
  let cattle = 0;

  // Eggs
  if (/Added Eggs/i.test(content)) {
    const amount = content.match(/:\s*(\d+)/);
    eggs = amount ? Number(amount[1]) : 0;
  }

  // Milk
  if (/Added Milk/i.test(content)) {
    const amount = content.match(/:\s*(\d+)/);
    milk = amount ? Number(amount[1]) : 0;
  }

  // Cattle (future-proof)
  if (/Added Cattle/i.test(content)) {
    const amount = content.match(/:\s*(\d+)/);
    cattle = amount ? Number(amount[1]) : 0;
  }

  if (eggs === 0 && milk === 0 && cattle === 0) return null;

  return { userId, eggs, milk, cattle };
}

// ---------- ENSURE STATIC LEADERBOARD ----------
async function ensureLeaderboardMessage() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });

  const existing = messages.find(
    (m) => m.author.id === client.user.id
  );

  if (existing) {
    leaderboardMessageId = existing.id;
  } else {
    const msg = await channel.send("🏆 Beaver Farms Ledger\nLoading...");
    leaderboardMessageId = msg.id;
  }

  await updateLeaderboardMessage();
}

// ---------- UPDATE LEADERBOARD (EDIT MESSAGE) ----------
async function updateLeaderboardMessage() {
  if (!leaderboardMessageId) return;

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(leaderboardMessageId);

  let output = "🏆 **Beaver Farms — Weekly Ledger**\n\n";
  let ranchTotal = 0;

  for (const [userId, data] of Object.entries(leaderboard)) {
    const user = await client.users.fetch(userId).catch(() => null);
    const name = user ? user.username : userId;

    const payout =
      data.eggs * PRICES.eggs +
      data.milk * PRICES.milk +
      data.cattle * PRICES.cattle;

    ranchTotal += payout;

    output +=
      `**${name}**\n` +
      `🥚 Eggs: ${data.eggs}\n` +
      `🥛 Milk: ${data.milk}\n` +
      `🐄 Cattle: ${data.cattle}\n` +
      `💰 **$${payout.toFixed(2)}**\n\n`;
  }

  output += `---\n💼 **Total Ranch Payroll:** $${ranchTotal.toFixed(2)}`;

  await message.edit(output);
  console.log("📊 Leaderboard updated");
}

// ---------- WEEKLY RESET ----------
function scheduleWeeklyReset() {
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  setInterval(async () => {
    console.log("🔄 Weekly payroll reset");
    leaderboard = {};
    await updateLeaderboardMessage();
  }, oneWeek);
}

// ---------- EXPRESS KEEP-ALIVE ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ---------- LOGIN ----------
client.login(process.env.BOT_TOKEN);
