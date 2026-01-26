import { Client, GatewayIntentBits } from 'discord.js';
import express from 'express';
import pg from 'pg';

const {
  PGHOST = 'postgres.railway.internal',
  PGUSER = 'postgres',
  PGPASSWORD = 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA',
  PGDATABASE = 'railway',
  PGPORT = 5432,
  DISCORD_TOKEN = 'YOUR_DISCORD_TOKEN_HERE',
  CHANNEL_ID = '1465062014626824347',
  PORT = 8080
} = process.env;

// PostgreSQL setup
const pool = new pg.Pool({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT
});

// Discord setup
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let leaderboardMessageId = null;

client.on('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Get the channel
  const channel = await client.channels.fetch(CHANNEL_ID);

  // Fetch the last leaderboard message if it exists
  const messages = await channel.messages.fetch({ limit: 10 });
  const lastLeaderboard = messages.find(msg => msg.author.id === client.user.id && msg.content.startsWith('🏆 Beaver Farms — Leaderboard'));
  if (lastLeaderboard) leaderboardMessageId = lastLeaderboard.id;

  // Post initial leaderboard if none exists
  if (!leaderboardMessageId) {
    const msg = await channel.send('🏆 Beaver Farms — Leaderboard\nFetching data...');
    leaderboardMessageId = msg.id;
  }

  // Initial update
  await updateLeaderboard();
});

// Function to update leaderboard
async function updateLeaderboard() {
  try {
    const res = await pool.query('SELECT username, milk, eggs, cattle, total FROM users ORDER BY username');
    let content = '🏆 Beaver Farms — Leaderboard\n';
    for (const row of res.rows) {
      content += `${row.username.toUpperCase()}\n🥛 Milk: ${row.milk}\n🥚 Eggs: ${row.eggs}\n🐄 Cattle: ${row.cattle}\n💰 Total: $${row.total.toFixed(2)}\n\n`;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    const msg = await channel.messages.fetch(leaderboardMessageId);
    await msg.edit(content.trim());
    console.log('Leaderboard updated!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// Express webhook server (optional if you have webhooks)
const app = express();
app.use(express.json());
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

client.login(DISCORD_TOKEN);
