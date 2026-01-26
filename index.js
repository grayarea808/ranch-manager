import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// --------------------
// RAILWAY VARIABLES
// --------------------
const CHANNEL_ID = '1465062014626824347';
const DISCORD_TOKEN = 'YOUR_DISCORD_TOKEN_HERE'; // replace with the current Railway token
const PGHOST = 'postgres.railway.internal';
const PGUSER = 'postgres';
const PGPASSWORD = 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA';
const PGDATABASE = 'railway';
const PGPORT = 5432;

// --------------------
// POSTGRES SETUP
// --------------------
const pool = new Pool({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT,
});

// --------------------
// DISCORD SETUP
// --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
let leaderboardMessageId = null;

// --------------------
// UPDATE LEADERBOARD
// --------------------
async function updateLeaderboard() {
  try {
    const res = await pool.query(`
      SELECT username, milk, eggs, cattle, total
      FROM leaderboard
      ORDER BY total DESC
      LIMIT 10
    `);

    if (res.rows.length === 0) return;

    let content = '🏆 Beaver Farms — Leaderboard\n';
    for (const row of res.rows) {
      content += `${row.username.toUpperCase()}\n`;
      content += `🥛 Milk: ${row.milk}\n`;
      content += `🥚 Eggs: ${row.eggs}\n`;
      content += `🐄 Cattle: ${row.cattle}\n`;
      content += `💰 Total: $${row.total.toFixed(2)}\n\n`;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    if (leaderboardMessageId) {
      const msg = await channel.messages.fetch(leaderboardMessageId);
      await msg.edit(content);
    } else {
      const msg = await channel.send(content);
      leaderboardMessageId = msg.id;
    }
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// --------------------
// CLIENT READY
// --------------------
client.on('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });
  const lastLeaderboard = messages.find(
    (msg) =>
      msg.author.id === client.user.id &&
      msg.content.startsWith('🏆 Beaver Farms — Leaderboard')
  );
  if (lastLeaderboard) leaderboardMessageId = lastLeaderboard.id;

  if (!leaderboardMessageId) {
    const msg = await channel.send('🏆 Beaver Farms — Leaderboard\nFetching data...');
    leaderboardMessageId = msg.id;
  }

  await updateLeaderboard();

  // Poll every 5 seconds
  setInterval(updateLeaderboard, 5000);
});

// --------------------
// LOGIN
// --------------------
client.login(DISCORD_TOKEN);
