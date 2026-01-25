// index.js

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// Load environment variables from .env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// PostgreSQL setup
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Discord bot setup with only safe intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds // Only this is needed for sending messages
  ]
});

// Bot ready
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

// Function to fetch leaderboard and post/update in Discord
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_data
      ORDER BY total DESC
      LIMIT 10
    `);

    if (!result.rows.length) return;

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

    // Edit existing bot message if exists
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
client.login(DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
