// ---------------------
// PostgreSQL Setup
// ---------------------
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  ssl: { rejectUnauthorized: false } // Required for Railway
});

// ---------------------
// Express / Webhook Setup
// ---------------------
import express from 'express';
const app = express();
app.use(express.json());

const WEBHOOK_PORT = process.env.PORT || 8080;

// ---------------------
// Discord Setup
// ---------------------
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

// ---------------------
// Leaderboard Update
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, (milk*1.1 + eggs*1.1 + cattle)::numeric AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Beaver Farms — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      const total = Number(row.total);
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle}\n`;
      leaderboardMessage += `💰 Total: $${total.toFixed(2)}\n\n`;
    });

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.error('Channel not found!');

    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id);

    if (botMessage) {
      await botMessage.edit(leaderboardMessage);
    } else {
      await channel.send(leaderboardMessage);
    }

    console.log('Leaderboard updated!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Webhook Endpoint
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  console.log('📩 Webhook received!');
  console.log(req.body);

  try {
    const data = req.body;

    // Parse username
    const username = data.username.split(' ')[2]; // Adjust if format differs

    // Check what item was added
    if (data.embeds && data.embeds.length) {
      const desc = data.embeds[0].description.toLowerCase();
      let field = null;
      let amount = 0;

      if (desc.includes('milk')) field = 'milk';
      else if (desc.includes('eggs')) field = 'eggs';
      else if (desc.includes('cattle')) field = 'cattle';

      const match = desc.match(/: (\d+)/);
      if (match) amount = parseInt(match[1]);

      if (field && amount) {
        await pool.query(`
          INSERT INTO ranch_stats(username, milk, eggs, cattle)
          VALUES ($1, 0, 0, 0)
          ON CONFLICT (username) DO NOTHING
        `, [username]);

        await pool.query(`
          UPDATE ranch_stats
          SET ${field} = ${field} + $1
          WHERE username = $2
        `, [amount, username]);

        console.log(`✅ Updated ${field} for ${username} by ${amount}`);
        updateLeaderboard(); // refresh after each update
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.sendStatus(500);
  }
});

// ---------------------
// Start Webhook Server
// ---------------------
app.listen(WEBHOOK_PORT, () => {
  console.log(`Webhook server listening on port ${WEBHOOK_PORT}`);
});

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
