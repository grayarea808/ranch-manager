// index.js
import 'dotenv/config';

// ---------------------
// PostgreSQL Setup (Railway-safe)
// ---------------------
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// ---------------------
// Discord Setup
// ---------------------
import { Client, GatewayIntentBits, Events } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Bot Ready
// ---------------------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Test DB connection once on startup
  try {
    await pool.query('SELECT 1');
    console.log('Postgres connected successfully');
  } catch (err) {
    console.error('Postgres connection failed:', err);
  }

  await updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
             milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_data
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Baba Yaga Ranch — Leaderboard\n\n';

    result.rows.forEach((row, i) => {
      leaderboardMessage +=
        `${i + 1}. ${row.username}\n` +
        `🥛 Milk: ${row.milk}\n` +
        `🥚 Eggs: ${row.eggs}\n` +
        `🐄 Cattle: ${row.cattle}\n` +
        `💰 Total: $${Number(row.total).toFixed(2)}\n\n`;
    });

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('Channel not found');
      return;
    }

    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id);

    if (botMessage) {
      await botMessage.edit(leaderboardMessage);
    } else {
      await channel.send(leaderboardMessage);
    }

    console.log('Leaderboard updated successfully');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
