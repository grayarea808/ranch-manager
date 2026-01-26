// ---------------------
// Imports
// ---------------------
import express from 'express';
import pkg from 'pg';
import { Client, GatewayIntentBits } from 'discord.js';

// ---------------------
// PostgreSQL
// ---------------------
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('Postgres connected'))
  .catch(err => console.error('Postgres error:', err));

// ---------------------
// Discord
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express
// ---------------------
const app = express();
app.use(express.json());

// ---------------------
// WEBHOOK HANDLER
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    console.log('📩 Webhook received!');
    console.log(JSON.stringify(req.body, null, 2));

    const rawUsername = req.body.username || 'Unknown';
    const embed = req.body.embeds?.[0];

    if (!embed) {
      return res.status(200).json({ ok: true });
    }

    // Clean username (take last word)
    const username = rawUsername.split(' ').pop();

    const title = embed.title || '';
    const description = embed.description || '';

    // Extract number at end of string
    const amountMatch = description.match(/:\s*(\d+)/);
    const amount = amountMatch ? parseInt(amountMatch[1]) : 0;

    let column = null;

    if (title.includes('Egg')) column = 'eggs';
    if (title.includes('Milk')) column = 'milk';
    if (title.includes('Cattle')) column = 'cattle';

    if (!column || amount === 0) {
      console.log('⚠️ No valid stat found');
      return res.status(200).json({ ok: true });
    }

    // Upsert
    await pool.query(
      `
      INSERT INTO ranch_stats (username, ${column})
      VALUES ($1, $2)
      ON CONFLICT (username)
      DO UPDATE SET ${column} = ranch_stats.${column} + EXCLUDED.${column}
      `,
      [username, amount]
    );

    console.log(`✅ Updated ${username}: +${amount} ${column}`);

    await updateLeaderboard();

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

// ---------------------
// Health Check
// ---------------------
app.get('/', (req, res) => {
  res.send('Ranch Manager online');
});

const PORT = process.env.PORT || 3000;
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
    console.error('Leaderboard error:', err);
  }
}

// ---------------------
// Discord Login
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
