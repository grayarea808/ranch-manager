import 'dotenv/config';
// index.js

// Load environment variables
require('dotenv').config();

// PostgreSQL setup
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Railway
});

// Discord setup
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// Your environment variables in Railway:
// DISCORD_TOKEN = your bot token
// GUILD_ID = your server ID
// CHANNEL_ID = the channel where leaderboard messages will post

const CHANNEL_ID = process.env.CHANNEL_ID;

// Bot ready
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();
  // Update leaderboard every 5 minutes
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

// Function to fetch leaderboard from PostgreSQL and post it
async function updateLeaderboard() {
  try {
    // Example: get top players by total money
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_data
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Baba Yaga Ranch — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle}\n`;
      leaderboardMessage += `💰 Total: $${row.total.toFixed(2)}\n\n`;
    });

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.error('Channel not found!');

    // If you want it to **update existing message** instead of spamming:
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id);
    if (botMessage) {
      await botMessage.edit(leaderboardMessage);
    } else {
      await channel.send(leaderboardMessage);
    }

  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// Login Discord bot
client.login(process.env.DISCORD_TOKEN);

