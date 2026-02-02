import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;

// Your channels
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID; // 1465062014626824347
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID; // 1466170240949026878

const PRICES = {
  eggs: 1.25,
  milk: 1.25,
  cattle: 800,
};

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("Ranch Manager online ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// IMPORTANT: Railway needs this to stay alive
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Web server listening on port ${PORT}`);
});

// ---------- DISCORD ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // MUST ALSO be enabled in Dev Portal
  ],
});

// ---------- IN-MEMORY STORAGE ----------
let leaderboard = {};
let leaderboardMessageId = null;

// ---------- READY ----------
client.once("ready", async () => {
  console.log(`🚜 Ranch Manager online as ${client.user.tag}`);

  if (!INPUT_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID) {
    console.log("❌ Missing INPUT_CHANNEL_ID or LEADERBOARD_CHANNEL_ID in env");
    return;
  }

  await ensureLeaderboardMessage();
  await bootstrapFromHistory(); // <-- pulls existing dump logs on startup
  await updateLeaderboardMessage();

  scheduleWeeklyReset();
});

// ---------- LIVE MESSAGE LISTENER ----------
client.on("messageCreate", async (message) => {
  // Only parse messages in the input channel
  if (message.channel.id !== INPUT_CHANNEL_ID) return;

  // Only parse bot/webhook messages
  if (!message.author.bot) return;

  const parsed = parseRanchMessage(message.content);
  if (!parsed) return;

  applyParsed(parsed);

  await updateLeaderboardMessage();
});

// ---------- PARSER (YOUR FORMAT) ----------
function parseRanchMessage(content) {
  // Must have a mention like <@3164...>
  const userMatch = content.match(/<@(\d+)>/);
  if (!userMatch) return null;

  const userId = userMatch[1];

  let eggs = 0;
  let milk = 0;
  let cattle = 0;

  // Pull number after ": 33"
  const amountMatch = content.match(/:\s*(\d+)/);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;

  if (/Added Eggs/i.test(content)) eggs = amount;
  if (/Added Milk/i.test(content)) milk = amount;
  if (/Added Cattle/i.test(content)) cattle = amount;

  if (eggs === 0 && milk === 0 && cattle === 0) return null;

  return { userId, eggs, milk, cattle };
}

function applyParsed({ userId, eggs, milk, cattle }) {
  if (!leaderboard[userId]) {
    leaderboard[userId] = { eggs: 0, milk: 0, cattle: 0 };
  }

  leaderboard[userId].eggs += eggs;
  leaderboard[userId].milk += milk;
  leaderboard[userId].cattle += cattle;

  console.log(`✅ Applied -> ${userId}:`, leaderboard[userId]);
}

// ---------- BOOTSTRAP FROM HISTORY ----------
async function bootstrapFromHistory() {
  try {
    const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
    if (!channel) throw new Error("Input channel not found");

    // Pull the last 100 messages (adjust if you want more)
    const messages = await channel.messages.fetch({ limit: 100 });

    let count = 0;

    // Oldest to newest so totals apply in order
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      if (!msg.author.bot) continue;

      const parsed = parseRanchMessage(msg.content);
      if (!parsed) continue;

      applyParsed(parsed);
      count++;
    }

    console.log(`📥 Bootstrapped ${count} ranch log entries from history`);
  } catch (err) {
    console.error("❌ bootstrapFromHistory failed:", err);
  }
}

// ---------- ENSURE STATIC LEADERBOARD MESSAGE ----------
async function ensureLeaderboardMessage() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });

  const existing = messages.find((m) => m.author.id === client.user.id);

  if (existing) {
    leaderboardMessageId = existing.id;
  } else {
    const msg = await channel.send("🏆 Beaver Farms — Weekly Ledger\nLoading...");
    leaderboardMessageId = msg.id;
  }
}

// ---------- UPDATE (EDIT) LEADERBOARD ----------
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

// ---------- LOGIN ----------
client.login(process.env.BOT_TOKEN);
