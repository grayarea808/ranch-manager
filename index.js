// ---------------------
// Imports
// ---------------------
import express from 'express';
import pkg from 'pg';
import { Client, GatewayIntentBits } from 'discord.js';

// ---------------------
// PostgreSQL Setup
// ---------------------
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('Postgres connected'))
  .catch(err => console.error('Postgres connection error:', err));

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express (Webhook Server)
// ---------------------
const app = express();
app.use(express.json());

// 🔔 WEBHOOK ENDPOINT
app.post('/webhook/ranch', async (req, res) => {
  console.log('📩 Webhook received!');
  console.log(JSON.stringify(req.body, null, 2));

  // TEMP response so the game is happy
  res.status(200).json({ ok: true });
});

// Health check
app.get('/', (req, res) => {
  res.send('Ranch Manager online');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// ---------------------
// Discord Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
             milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let msg = '🏆 **Beaver Farms — Leaderboard**\n\n';

    result.rows.forEach((r, i) => {
      msg += `**${i + 1}. ${r.username}**\n`;
      msg += `🥛 Milk: ${r.milk}\n`;
      msg += `🥚 Eggs: ${r.eggs}\n`;
      msg += `🐄 Cattle: ${r.cattle}\n`;
      msg += `💰 Total: $${Number(r.total).toFixed(2)}\n\n`;
    });

    const channel = await client.channels.fetch(CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 5 });
    const botMsg = messages.find(m => m.author.id === client.user.id);

    botMsg ? await botMsg.edit(msg) : await channel.send(msg);
    console.log('Leaderboard updated');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Login
// ---------------------
client.login(process.env.DISCORD_TOKEN);
