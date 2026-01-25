// index.js
import 'dotenv/config'; // Loads .env automatically

// PostgreSQL setup
import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false } // required for Railway
});

// Discord setup
import { Client, GatewayIntentBits } from 'discord.js';
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// Discord environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Safety check
if (!DISCORD_TOKEN) {
  console.error("⚠️ DISCORD_TOKEN is missing!");
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error("⚠️ CHANNEL_ID is missing!");
  process.exit(1);
}

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

    // Update existing message if exists
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
client.login(DISCORD_TOKEN);
