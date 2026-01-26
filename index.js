import { Client, GatewayIntentBits, Events } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// --------------------
// RAILWAY VARIABLES
// --------------------
const CHANNEL_ID = '1465062014626824347';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // <- Railway variable
const PGHOST = process.env.PGHOST;
const PGUSER = process.env.PGUSER;
const PGPASSWORD = process.env.PGPASSWORD;
const PGDATABASE = process.env.PGDATABASE;
const PGPORT = process.env.PGPORT;

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

await pool.query(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    username TEXT PRIMARY KEY,
    milk INT DEFAULT 0,
    eggs INT DEFAULT 0,
    cattle INT DEFAULT 0,
    total NUMERIC DEFAULT 0
  );
`);

// --------------------
// DISCORD SETUP
// --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let leaderboardMessageId = null;

// --------------------
// UPDATE LEADERBOARD
// --------------------
async function updateLeaderboard() {
  const res = await pool.query(`
    SELECT username, milk, eggs, cattle, total
    FROM leaderboard
    ORDER BY total DESC
    LIMIT 10
  `);

  let content = '🏆 Beaver Farms — Leaderboard\n';
  if (res.rows.length === 0) {
    content += 'No data yet.';
  } else {
    for (const row of res.rows) {
      content += `${row.username.toUpperCase()}\n`;
      content += `🥛 Milk: ${row.milk}\n`;
      content += `🥚 Eggs: ${row.eggs}\n`;
      content += `🐄 Cattle: ${row.cattle}\n`;
      content += `💰 Total: $${row.total.toFixed(2)}\n\n`;
    }
  }

  const channel = await client.channels.fetch(CHANNEL_ID);

  if (leaderboardMessageId) {
    const msg = await channel.messages.fetch(leaderboardMessageId);
    await msg.edit(content);
  } else {
    const msg = await channel.send(content);
    leaderboardMessageId = msg.id;
  }
}

// --------------------
// WEBHOOK OR MESSAGE HANDLER
// --------------------
// Example using Discord messages (can be swapped with webhook)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!add')) return;

  const parts = message.content.split(' ');
  if (parts.length !== 3) return;

  const item = parts[1].toLowerCase();
  const amount = parseInt(parts[2]);
  if (!['milk', 'eggs', 'cattle'].includes(item)) return;
  if (isNaN(amount)) return;

  const username = message.author.username;

  await pool.query(`
    INSERT INTO leaderboard (username, ${item}, total)
    VALUES ($1, $2, $2)
    ON CONFLICT (username)
    DO UPDATE SET
      ${item} = leaderboard.${item} + EXCLUDED.${item},
      total = leaderboard.milk + leaderboard.eggs + leaderboard.cattle;
  `, [username, amount]);

  await updateLeaderboard();
});

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

  // Poll DB every 10s in case it changes outside Discord
  setInterval(updateLeaderboard, 10000);
});

// --------------------
// LOGIN
// --------------------
client.login(DISCORD_TOKEN);
