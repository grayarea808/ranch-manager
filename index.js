import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;

// Railway Variables (set in Railway UI)
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID; // 1465062014626824347
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID; // 1466170240949026878

// Optional: set to "true" in Railway if you want verbose logs
const DEBUG = process.env.DEBUG === "true";

const PRICES = {
  eggs: 1.25,
  milk: 1.25,
  cattle: 800,
};

// ---------- EXPRESS (Railway keep-alive) ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("Ranch Manager online ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Web server listening on port ${PORT}`);
});

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // MUST be enabled in Dev Portal too
  ],
});

// ---------- IN-MEMORY LEADERBOARD ----------
let leaderboard = {}; // { [userId]: { eggs, milk, cattle } }
let leaderboardMessageId = null;

// ---------- READY ----------
client.once("ready", async () => {
  console.log(`🚜 Ranch Manager online as ${client.user.tag}`);

  if (!INPUT_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID) {
    console.log("❌ Missing INPUT_CHANNEL_ID or LEADERBOARD_CHANNEL_ID in Railway variables");
    return;
  }

  await ensureLeaderboardMessage();
  await bootstrapFromHistory(100); // read last 100 dump messages on startup
  await updateLeaderboardMessage();

  scheduleWeeklyReset();
});

// ---------- LISTEN FOR NEW WEBHOOK LOGS ----------
client.on("messageCreate", async (message) => {
  if (message.channel.id !== INPUT_CHANNEL_ID) return;

  // Webhook messages often have webhookId; also allow bot posts just in case
  const isWebhookOrBot = Boolean(message.webhookId) || Boolean(message.author?.bot);
  if (!isWebhookOrBot) return;

  if (DEBUG) {
    console.log("INCOMING:", {
      channel: message.channel.id,
      content: message.content,
      webhookId: message.webhookId,
      embeds: message.embeds?.map((e) => ({
        title: e.title,
        description: e.description,
        fields: e.fields?.map((f) => ({ name: f.name, value: f.value })),
      })),
    });
  }

  const parsed = parseRanchMessageFromDiscordMessage(message);
  if (!parsed) return;

  applyParsed(parsed);
  await updateLeaderboardMessage();
});

// ---------- PARSER (WORKS FOR EMBEDS + CONTENT) ----------
function parseRanchMessageFromDiscordMessage(message) {
  // Combine all possible sources of text (content + embeds)
  let text = (message.content || "").trim();

  if (message.embeds?.length) {
    for (const emb of message.embeds) {
      if (emb.title) text += `\n${emb.title}`;
      if (emb.description) text += `\n${emb.description}`;
      if (emb.fields?.length) {
        for (const f of emb.fields) {
          if (f.name) text += `\n${f.name}`;
          if (f.value) text += `\n${f.value}`;
        }
      }
    }
  }

  text = text.trim();
  if (!text) return null;

  // Must have a mention like <@316442197715189770>
  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;

  const userId = userMatch[1];

  // Amount is usually the last number after ": 22"
  const amountMatch = text.match(/:\s*(\d+)\s*$/m);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;

  let eggs = 0,
    milk = 0,
    cattle = 0;

  // Your webhook uses both "Eggs Added" and "Added Eggs..."
  if (/Eggs Added/i.test(text) || /Added Eggs/i.test(text)) eggs = amount;
  if (/Milk Added/i.test(text) || /Added Milk/i.test(text)) milk = amount;
  if (/Cattle Added/i.test(text) || /Added Cattle/i.test(text)) cattle = amount;

  if (!eggs && !milk && !cattle) return null;

  return { userId, eggs, milk, cattle };
}

// ---------- APPLY TO TOTALS ----------
function applyParsed({ userId, eggs, milk, cattle }) {
  if (!leaderboard[userId]) leaderboard[userId] = { eggs: 0, milk: 0, cattle: 0 };

  leaderboard[userId].eggs += eggs;
  leaderboard[userId].milk += milk;
  leaderboard[userId].cattle += cattle;

  console.log(`✅ Applied -> ${userId}:`, leaderboard[userId]);
}

// ---------- READ HISTORY ON STARTUP (so it isn't 0 after restart) ----------
async function bootstrapFromHistory(limit = 100) {
  try {
    const channel = await client.channels.fetch(INPUT_CHANNEL_ID);
    if (!channel) throw new Error("Input channel not found");

    const messages = await channel.messages.fetch({ limit });

    const sorted = [...messages.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    let count = 0;

    for (const msg of sorted) {
      const isWebhookOrBot = Boolean(msg.webhookId) || Boolean(msg.author?.bot);
      if (!isWebhookOrBot) continue;

      const parsed = parseRanchMessageFromDiscordMessage(msg);
      if (!parsed) continue;

      applyParsed(parsed);
      count++;
    }

    console.log(`📥 Bootstrapped ${count} ranch entries from last ${limit} messages`);
  } catch (err) {
    console.error("❌ bootstrapFromHistory failed:", err);
  }
}

// ---------- ENSURE ONE STATIC MESSAGE IN LEADERBOARD CHANNEL ----------
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

// ---------- EDIT THE STATIC MESSAGE ----------
async function updateLeaderboardMessage() {
  if (!leaderboardMessageId) return;

  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(leaderboardMessageId);

  let output = "🏆 **Beaver Farms — Weekly Ledger**\n\n";

  // Sort by payout desc (clean leaderboard vibes)
  const rows = [];

  for (const [userId, data] of Object.entries(leaderboard)) {
    const payout =
      data.eggs * PRICES.eggs +
      data.milk * PRICES.milk +
      data.cattle * PRICES.cattle;

    rows.push({ userId, data, payout });
  }

  rows.sort((a, b) => b.payout - a.payout);

  let ranchTotal = 0;

  for (const row of rows) {
    const user = await client.users.fetch(row.userId).catch(() => null);
    const name = user ? user.username : row.userId;

    ranchTotal += row.payout;

    output +=
      `**${name}**\n` +
      `🥚 Eggs: ${row.data.eggs}\n` +
      `🥛 Milk: ${row.data.milk}\n` +
      `🐄 Cattle: ${row.data.cattle}\n` +
      `💰 **$${row.payout.toFixed(2)}**\n\n`;
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
