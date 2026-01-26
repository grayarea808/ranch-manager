import { Client, GatewayIntentBits } from 'discord.js';
import pg from 'pg';

const { Pool } = pg;

// PostgreSQL connection using Railway environment variables
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: parseInt(process.env.PGPORT || '5432', 10),
  ssl: { rejectUnauthorized: false },
});

// Discord setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const CHANNEL_ID = process.env.CHANNEL_ID;

// Prices
const PRICES = {
  milk: 1.25,
  eggs: 1.25,
  cattle: 200,
};
const FARM_CUT = 0.2; // 20% cut

let leaderboardMessageId = null; // will store ID of the message to edit

// Weekly leaderboard reset
async function resetLeaderboardIfNeeded() {
  const res = await pool.query('SELECT last_reset FROM leaderboard_reset LIMIT 1');
  const now = new Date();
  let lastReset = res.rows[0]?.last_reset ? new Date(res.rows[0].last_reset) : new Date(0);

  // Reset if more than 7 days
  if ((now - lastReset) / (1000 * 60 * 60 * 24) >= 7) {
    await pool.query('UPDATE leaderboard_reset SET last_reset = NOW()');
    await pool.query('UPDATE leaderboard SET milk = 0, eggs = 0, cattle = 0, total = 0');
  }
}

// Calculate totals and update database
async function updateTotals() {
  const res = await pool.query('SELECT id, milk, eggs, cattle FROM leaderboard');

  const updates = res.rows.map(row => {
    const cattleTotal = PRICES.cattle * row.cattle * (1 - FARM_CUT);
    const total = PRICES.milk * row.milk + PRICES.eggs * row.eggs + cattleTotal;

    return pool.query('UPDATE leaderboard SET total = $1 WHERE id = $2', [total, row.id]);
  });

  await Promise.all(updates);
}

// Build leaderboard message content
async function buildLeaderboardMessage() {
  const res = await pool.query('SELECT discord_id, username, milk, eggs, cattle, total FROM leaderboard ORDER BY total DESC');
  let message = '🏆 Beaver Farms — Leaderboard\n\n';

  res.rows.forEach(row => {
    message += `@${row.username} ${row.username}\n`;
    message += `🥛 Milk: ${row.milk}\n`;
    message += `🥚 Eggs: ${row.eggs}\n`;
    message += `🐄 Cattle: ${row.cattle}\n`;
    message += `💰 Total: $${row.total.toFixed(2)}\n\n`;
  });

  return message;
}

// Update leaderboard in Discord
async function updateLeaderboard() {
  try {
    await resetLeaderboardIfNeeded();
    await updateTotals();
    const channel = await client.channels.fetch(CHANNEL_ID);
    const content = await buildLeaderboardMessage();

    if (!leaderboardMessageId) {
      const msg = await channel.send(content);
      leaderboardMessageId = msg.id;
    } else {
      const msg = await channel.messages.fetch(leaderboardMessageId);
      await msg.edit(content);
    }

    console.log('Leaderboard updated!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Update leaderboard every 5 minutes
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
