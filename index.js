// index.js
import 'dotenv/config'; // for ES Modules
import { Pool } from 'pg';
import { Client, GatewayIntentBits } from 'discord.js';

// -----------------------
// PostgreSQL Setup
// -----------------------
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false } // Required for Railway
});

// -----------------------
// Discord Bot Setup
// -----------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // Needed to fetch and edit messages
  ]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// -----------------------
// Leaderboard Function
// -----------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_data
      ORDER BY total DESC
      LIMIT 10
    `);

    if (!result.rows.length) {
      console.log('No data found in ranch_data table.');
      return;
    }

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

    // Edit previous bot message if exists
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id);

    if (botMessage) {
      await botMessage.edit(leaderboardMessage);
      console.log('Leaderboard updated!');
    } else {
      await channel.send(leaderboardMessage);
      console.log('Leaderboard posted!');
    }
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// -----------------------
// Bot Login and Interval
// -----------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard(); // first run
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

client.on('error', (err) => console.error('Discord client error:', err));

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
