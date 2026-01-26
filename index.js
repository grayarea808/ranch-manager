import { Client, GatewayIntentBits, Events } from 'discord.js';
import pkg from 'pg';
import express from 'express';
import bodyParser from 'body-parser';
const { Pool } = pkg;

// --------------------
// RAILWAY VARIABLES
// --------------------
const CHANNEL_ID = '1465062014626824347';
const DISCORD_TOKEN = 'YOUR_DISCORD_TOKEN_HERE'; // <-- put your bot token here
const PGHOST = 'postgres.railway.internal';
const PGUSER = 'postgres';
const PGPASSWORD = 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA';
const PGDATABASE = 'railway';
const PGPORT = 5432;
const PORT = 8080; // webhook server port

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
// EXPRESS WEBHOOK SERVER
// --------------------
const app = express();
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  try {
    const { username, item, amount } = req.body;

    if (!username || !item || !amount) {
      return res.status(400).json({ error: 'username, item, and amount required' });
    }

    if (!['milk', 'eggs', 'cattle'].includes(item)) {
      return res.status(400).json({ error: 'invalid item' });
    }

    // Upsert leaderboard
    await pool.query(`
      INSERT INTO leaderboard (username, ${item}, total)
      VALUES ($1, $2, $2)
      ON CONFLICT (username)
      DO UPDATE SET
        ${item} = leaderboard.${item} + EXCLUDED.${item},
        total = leaderboard.milk + leaderboard.eggs + leaderboard.cattle + EXCLUDED.${item};
    `, [username, amount]);

    // Update Discord message
    await updateLeaderboard();

    res.json({ status: 'success' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// --------------------
// DISCORD SETUP
// --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
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
});

// --------------------
// LOGIN
// --------------------
client.login(DISCORD_TOKEN);
