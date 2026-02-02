import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;

const PRICES = {
  eggs: 1.25,
  milk: 1.25,
  cattle: 800,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let leaderboard = {};
let leaderboardMessageId = null;

// ---------- Discord Ready ----------
client.once("ready", async () => {
  console.log(`🚜 Ranch Manager online as ${client.user.tag}`);
  await ensureLeaderboardMessage();
  scheduleWeeklyReset();
});

// ---------- Parse Incoming Ranch Messages ----------
client.on("messageCreate", async (message) => {
  if (message.channel.id !== INPUT_CHANNEL_ID) return;
  if (message.author.bot === false) return;

  const parsed = parseRanchMessage(message.content);
  if (!parsed) return;

  const { username, eggs, milk, cattle } = parsed;

  if (!leaderboard[username]) {
    leaderboard[username] = { eggs: 0, milk: 0, cattle: 0 };
  }

  leaderboard[username].eggs += eggs;
  leaderboard[username].milk += milk;
  leaderboard[username].cattle += cattle;

  console.log(`✅ Logged sale for ${username}`, leaderboard[username]);
  await updateLeaderboardMessage();
});

// ---------- Message Parser ----------
function parseRanchMessage(content) {
  try {
    const userMatch = content.match(/User:\s*(.+)/i);
    if (!userMatch) return null;

    const eggs = Number(content.match(/Eggs:\s*(\d+)/i)?.[1] || 0);
    const milk = Number(content.match(/Milk:\s*(\d+)/i)?.[1] || 0);
    const cattle = Number(content.match(/Cattle:\s*(\d+)/i)?.[1] || 0);

    return {
      username: userMatch[1].trim(),
      eggs,
      milk,
      cattle,
    };
  } catch {
    return null;
  }
}

// ---------- Ensure Static Leaderboard ----------
async function ensureLeaderboardMessage() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 5 });

  const existing = messages.find(
    (m) => m.author.id === client.user.id
  );

  if (existing) {
    leaderboardMessageId = existing.id;
  } else {
    const msg = await channel.send("🏆 Beaver Farms Leaderboard\nLoading...");
    leaderboardMessageId = msg.id;
  }

  await updateLeaderboardMessage();
}

// ---------- Update (EDIT) Leaderboard ----------
async function updateLeaderboardMessage() {
  if (!leaderboardMessageId) return;

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(leaderboardMessageId);

  let output = "🏆 **Beaver Farms — Weekly Ledger**\n\n";

  let grandTotal = 0;

  for (const [user, data] of Object.entries(leaderboard)) {
    const payout =
      data.eggs * PRICES.eggs +
      data.milk * PRICES.milk +
      data.cattle * PRICES.cattle;

    grandTotal += payout;

    output +=
      `**${user}**\n` +
      `🥚 Eggs: ${data.eggs}\n` +
      `🥛 Milk: ${data.milk}\n` +
      `🐄 Cattle: ${data.cattle}\n` +
      `💰 Payout: **$${payout.toFixed(2)}**\n\n`;
  }

  output += `---\n💼 **Total Ranch Payout:** $${grandTotal.toFixed(2)}`;

  await message.edit(output);
  console.log("📊 Leaderboard refreshed");
}

// ---------- Weekly Reset ----------
function scheduleWeeklyReset() {
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  setInterval(async () => {
    console.log("🔄 Weekly payroll reset");
    leaderboard = {};
    await updateLeaderboardMessage();
  }, oneWeek);
}

// ---------- Express (kept alive for Railway) ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ---------- Discord Login ----------
client.login(process.env.BOT_TOKEN);
