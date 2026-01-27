import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

// Prices
const PRICES = {
  milk: 1.25,
  eggs: 1.25,
  cattle: 160
};

// In-memory ranch data
const ranchData = {};

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

let leaderboardMessageId = null; // store message ID for editing

client.on('clientReady', () => {
  console.log(`🚜 Ranch Manager running as ${client.user.tag}`);
  updateLeaderboard().catch(console.error);
});

// Webhook to receive updates
app.post('/webhook', async (req, res) => {
  const { username, milk = 0, eggs = 0, cattle = 0 } = req.body;

  if (!username) {
    return res.status(400).send({ error: 'Missing username' });
  }

  // Update ranch data
  if (!ranchData[username]) ranchData[username] = { milk: 0, eggs: 0, cattle: 0 };
  ranchData[username].milk += milk;
  ranchData[username].eggs += eggs;
  ranchData[username].cattle += cattle;

  console.log(`📊 Updated ranch for ${username}`);
  
  // Update leaderboard
  try {
    await updateLeaderboard();
  } catch (err) {
    console.error('❌ Error updating leaderboard:', err);
  }

  res.send({ status: 'ok' });
});

// Calculate total
function calculateTotal(playerData) {
  const milkValue = (playerData.milk || 0) * PRICES.milk;
  const eggsValue = (playerData.eggs || 0) * PRICES.eggs;
  const cattleValue = (playerData.cattle || 0) * PRICES.cattle;

  return (milkValue + eggsValue + cattleValue).toFixed(2);
}

// Update leaderboard (edits single message)
async function updateLeaderboard() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error('Invalid channel');

  // Sort players by total value descending
  const sortedPlayers = Object.entries(ranchData).sort((a, b) => {
    return calculateTotal(b[1]) - calculateTotal(a[1]);
  });

  let leaderboardText = `🏆 Beaver Farms — Leaderboard\n\n`;
  
  for (const [username, data] of sortedPlayers) {
    leaderboardText += `${username}\n`;
    leaderboardText += `🥛 Milk: ${data.milk}\n`;
    leaderboardText += `🥚 Eggs: ${data.eggs}\n`;
    leaderboardText += `🐄 Cattle: ${data.cattle}\n`;
    leaderboardText += `💰 Total: $${calculateTotal(data)}\n\n`;
  }

  // Edit existing message if exists, otherwise send new
  if (leaderboardMessageId) {
    const message = await channel.messages.fetch(leaderboardMessageId).catch(() => null);
    if (message) {
      await message.edit(leaderboardText);
      return;
    }
  }

  const newMessage = await channel.send(leaderboardText);
  leaderboardMessageId = newMessage.id;
}

// Start Express server
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));

// Login Discord
client.login(DISCORD_TOKEN);
