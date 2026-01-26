// ---------------------
// Imports
// ---------------------
import express from 'express';
import pkg from 'pg';
import { Client, GatewayIntentBits } from 'discord.js';

const { Pool } = pkg;

// ---------------------
// PostgreSQL (Railway)
// ---------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('Postgres connected'))
  .catch(err => console.error('Postgres connection failed:', err));

// ---------------------
// Discord Bot
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express Webhook Server
// ---------------------
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Webhook endpoint
app.post('/webhook/ranch', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { username, milk = 0, eggs = 0, cattle = 0 } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Missing username' });
  }

  try {
    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle
    `, [username, milk, eggs, cattle]);

    res.json({ success: true });
  } catch (err) {
    console.error('Webhook DB error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// ---------------------
// Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
             milk*1.1 + eggs*1.1 + cattle AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let msg = '🏆 **Beaver Farms — Leaderboard**\n\n';

    if (result.rows.length === 0) {
      msg += '_No ranch data yet._';
    } else {
      result.rows.forEach((r, i) => {
        msg += `**${i + 1}. ${r.username}**\n`;
        msg += `🥛 Milk: ${r.milk}\n`;
        msg += `🥚 Eggs: ${r.eggs}\n`;
        msg += `🐄 Cattle: ${r.cattle}\n`;
        msg += `💰 Total: $${Number(r.total).toFixed(2)}\n\n`;
      });
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 5 });
    const botMsg = messages.find(m => m.author.id === client.user.id);

    if (botMsg) await botMsg.edit(msg);
    else await channel.send(msg);

    console.log('Leaderboard updated');
  } catch (err) {
    console.error('Leaderboard error:', err);
  }
}

// ---------------------
// Discord Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
