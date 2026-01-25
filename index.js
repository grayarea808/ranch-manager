// ---------------------
// Imports & Postgres Setup
// ---------------------
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Use Railway DATABASE_URL
  ssl: { rejectUnauthorized: false }          // Required for Railway
});

// Automatically create the table if it doesn't exist
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ranch_stats (
        username TEXT PRIMARY KEY,
        milk INT DEFAULT 0,
        eggs INT DEFAULT 0,
        cattle INT DEFAULT 0
      );
    `);
    console.log('Postgres table ready!');
  } catch (err) {
    console.error('Postgres table setup failed:', err);
  }
}

// ---------------------
// Discord Setup
// ---------------------
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_stats
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

    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id);

    if (botMessage) {
      await botMessage.edit(leaderboardMessage);
    } else {
      await channel.send(leaderboardMessage);
    }

    console.log('Leaderboard updated successfully!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Start Bot
// ---------------------
(async () => {
  await initDatabase(); // ensure table exists
  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('🚨 Failed to login Discord bot:', err);
  });
})();
