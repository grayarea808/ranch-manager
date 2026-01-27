import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const app = express();
app.use(express.json());

// ----- CONFIG -----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LEADERBOARD_CHANNEL_ID = '1465062014626824347';

// Prices
const PRICE_MILK = 1.25;
const PRICE_EGGS = 1.25;
const PRICE_CATTLE = 160;

// ----- DISCORD CLIENT -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// ----- RANCH DATA -----
// Track harvested and sold amounts separately
let ranchData = {}; 
// Structure: { username: { milk: 0, eggs: 0, cattle: 0, soldCattle: 0 } }

let leaderboardMessageId = null;

// ----- WEBHOOK -----
// Receive updates automatically
app.post('/webhook', (req, res) => {
  const { username, milk = 0, eggs = 0, cattle = 0, soldCattle = 0 } = req.body;

  if (!ranchData[username]) {
    ranchData[username] = { milk: 0, eggs: 0, cattle: 0, soldCattle: 0 };
  }

  // Add harvested milk and eggs
  ranchData[username].milk += milk;
  ranchData[username].eggs += eggs;

  // Add new cattle
  ranchData[username].cattle += cattle;

  // Handle sold cattle
  ranchData[username].cattle -= soldCattle;
  ranchData[username].soldCattle += soldCattle;

  if (ranchData[username].cattle < 0) ranchData[username].cattle = 0;

  res.sendStatus(200);
});

// ----- UPDATE LEADERBOARD -----
async function updateLeaderboard() {
  try {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    // Build leaderboard
    let content = '🏆 Beaver Farms — Leaderboard\n\n';
    for (const [username, data] of Object.entries(ranchData)) {
      const total =
        data.milk * PRICE_MILK +
        data.eggs * PRICE_EGGS +
        data.cattle * PRICE_CATTLE +
        data.soldCattle * PRICE_CATTLE;

      content += `@${username} ${username}\n`;
      content += `🥛 Milk: ${data.milk}\n`;
      content += `🥚 Eggs: ${data.eggs}\n`;
      content += `🐄 Cattle: ${data.cattle} (+${data.soldCattle} sold)\n`;
      content += `💰 Total: $${total.toFixed(2)}\n\n`;
    }

    // Edit existing message if possible
    if (leaderboardMessageId) {
      try {
        const message = await channel.messages.fetch(leaderboardMessageId);
        await message.edit(content);
      } catch (err) {
        if (err.code === 10008) { // message deleted
          const message = await channel.send(content);
          leaderboardMessageId = message.id;
        } else {
          throw err;
        }
      }
    } else {
      const message = await channel.send(content);
      leaderboardMessageId = message.id;
    }
  } catch (err) {
    console.error('❌ Error updating leaderboard:', err);
  }
}

// ----- AUTO UPDATE TIMER -----
setInterval(updateLeaderboard, 5000);

// ----- START SERVER & DISCORD -----
app.listen(8080, () => console.log('🚀 Webhook running on port 8080'));

client.login(DISCORD_TOKEN)
  .then(() => console.log(`🚜 Ranch Manager running as ${client.user.tag}`))
  .catch(console.error);
