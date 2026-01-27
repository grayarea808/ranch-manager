import express from 'express';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

// Prices
const PRICE_MILK = 1.25;
const PRICE_EGGS = 1.25;
const PRICE_CATTLE = 160;

// In-memory storage for ranch data
let ranchData = {};
let leaderboardMessageId = null;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('clientReady', async () => {
  console.log(`🚜 Ranch Manager running as ${client.user.tag}`);

  // Fetch the channel and existing message if stored
  try {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      const messages = await channel.messages.fetch({ limit: 50 });
      const existing = messages.find(m => m.author.id === client.user.id);
      if (existing) leaderboardMessageId = existing.id;
      updateLeaderboard(); // initial render
    }
  } catch (err) {
    console.error('Error fetching leaderboard channel:', err);
  }
});

// Function to update or send the single leaderboard message
async function updateLeaderboard() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  // Build leaderboard content
  let content = '🏆 Beaver Farms — Leaderboard\n\n';
  for (const [username, data] of Object.entries(ranchData)) {
    const total =
      data.milk * PRICE_MILK +
      data.eggs * PRICE_EGGS +
      data.cattle * PRICE_CATTLE;
    content += `@${username} ${username}\n`;
    content += `🥛 Milk: ${data.milk}\n`;
    content += `🥚 Eggs: ${data.eggs}\n`;
    content += `🐄 Cattle: ${data.cattle}\n`;
    content += `💰 Total: $${total.toFixed(2)}\n\n`;
  }

  try {
    if (leaderboardMessageId) {
      const message = await channel.messages.fetch(leaderboardMessageId);
      await message.edit(content);
    } else {
      const message = await channel.send(content);
      leaderboardMessageId = message.id;
    }
  } catch (err) {
    console.error('❌ Error updating leaderboard:', err);
  }
}

// Webhook endpoint for adding milk, eggs, cattle
app.post('/webhook', (req, res) => {
  const { username, milk = 0, eggs = 0, cattle = 0 } = req.body;
  if (!username) return res.status(400).send('Missing username');

  if (!ranchData[username]) ranchData[username] = { milk: 0, eggs: 0, cattle: 0 };
  ranchData[username].milk += milk;
  ranchData[username].eggs += eggs;
  ranchData[username].cattle += cattle;

  updateLeaderboard();
  res.send('Ranch data updated');
});

app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));

client.login(BOT_TOKEN);
