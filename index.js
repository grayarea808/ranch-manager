// ---------------------
// Imports & Postgres Setup
// ---------------------
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway DATABASE_URL
  ssl: { rejectUnauthorized: false }          // Required for Railway
});

// Ensure table exists
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

const CHANNEL_ID = process.env.CHANNEL_ID;
let leaderboardMessageId = null;

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await updateLeaderboard(); // initial update
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    // Get top 10 leaderboard
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

    if (leaderboardMessageId) {
      // Edit existing message
      const oldMessage = await channel.messages.fetch(leaderboardMessageId).catch(() => null);
      if (oldMessage) {
        await oldMessage.edit(leaderboardMessage);
        return;
      }
    }

    // Send new message if none exists
    const newMessage = await channel.send(leaderboardMessage);
    leaderboardMessageId = newMessage.id;
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Update Member Stats (Real-time)
// ---------------------
async function addStats(username, milk = 0, eggs = 0, cattle = 0) {
  try {
    // Insert or update member stats
    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET 
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle
    `, [username, milk, eggs, cattle]);

    // Update leaderboard immediately
    await updateLeaderboard();
  } catch (err) {
    console.error(`Failed to add stats for ${username}:`, err);
  }
}

// ---------------------
// Example usage (remove in production)
// ---------------------
// Simulate a member getting resources every 30 seconds
setInterval(() => addStats('Bradley', 1, 0, 0), 30_000);

// ---------------------
// Start Bot
// ---------------------
(async () => {
  await initDatabase();
  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('🚨 Failed to login Discord bot:', err);
  });
})();
