// index.js
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import cron from 'node-cron';

dotenv.config();

const app = express();
app.use(express.json());

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,          // Needed to access channels
    GatewayIntentBits.GuildMembers,    // Needed to track new users
    GatewayIntentBits.GuildMessages    // Needed to send messages
  ]
});

const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const PORT = process.env.PORT || 8080;

// In-memory leaderboard (use DB in production)
let leaderboard = {};

// Helper to calculate total value (example)
function calculateTotal(user) {
  const milk = user.milk || 0;
  const eggs = user.eggs || 0;
  const cattle = user.cattle || 0;
  return milk * 2 + eggs * 1 + cattle * 10; // simple pricing
}

// Update leaderboard message in Discord
async function updateLeaderboard() {
  try {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (!channel || !(channel instanceof TextChannel)) {
      console.error('Leaderboard channel is invalid.');
      return;
    }

    let message = '🏆 Beaver Farms — Leaderboard\n\n';
    for (const username in leaderboard) {
      const user = leaderboard[username];
      const total = calculateTotal(user);
      message += `**${username}**\n`;
      message += `🥛 Milk: ${user.milk || 0}\n`;
      message += `🥚 Eggs: ${user.eggs || 0}\n`;
      message += `🐄 Cattle: ${user.cattle || 0}\n`;
      message += `💰 Total: $${total}\n\n`;
    }

    // Send message
    await channel.send(message);
    console.log('📊 Leaderboard updated');
  } catch (err) {
    console.error('❌ Error updating leaderboard:', err);
  }
}

// Webhook endpoint to update leaderboard
app.post('/webhook', (req, res) => {
  const { username, milk = 0, eggs = 0, cattle = 0 } = req.body;
  if (!username) return res.status(400).send('Username required');

  if (!leaderboard[username]) {
    leaderboard[username] = { milk: 0, eggs: 0, cattle: 0 };
  }

  leaderboard[username].milk += milk;
  leaderboard[username].eggs += eggs;
  leaderboard[username].cattle += cattle;

  updateLeaderboard(); // update Discord immediately
  res.send('Leaderboard updated');
});

// Track new guild members automatically
client.on('guildMemberAdd', member => {
  if (!leaderboard[member.user.username]) {
    leaderboard[member.user.username] = { milk: 0, eggs: 0, cattle: 0 };
    updateLeaderboard();
  }
});

// Weekly reset: every Sunday at 00:00
cron.schedule('0 0 * * 0', () => {
  console.log('🔄 Resetting leaderboard for new week');
  leaderboard = {};
  updateLeaderboard();
});

// Start Express server
app.listen(PORT, () => console.log(`🚜 Ranch Manager running on port ${PORT}`));

// Login Discord bot
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
