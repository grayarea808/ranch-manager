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
  ssl: { rejectUnauthorized: false } // Railway requires this
});

// ---------------------
// Express Setup for Webhooks
// ---------------------
import express from 'express';
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

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
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // update every 5 min
});

// ---------------------
// Leaderboard Update
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk*1.1 + eggs*1.1 + cattle AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Beaver Farms — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle}\n`;
      leaderboardMessage += `💰 Total: $${row.total.toFixed(2)}\n\n`;
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
  try {
    const payload = req.body;
    console.log('📩 Webhook received!', JSON.stringify(payload, null, 2));

    // Extract username and changes from webhook
    const rawUsername = payload.username; // e.g., "<@123456> 123456 GRAYAREA"
    const username = rawUsername.split(' ').slice(-1)[0]; // GRAYAREA
    const embeds = payload.embeds || [];

    for (const embed of embeds) {
      const desc = embed.description || '';

      let milkChange = 0;
      let eggsChange = 0;
      let cattleChange = 0;

      if (/Added Milk/i.test(desc)) {
        const match = desc.match(/Added Milk .* : (\d+)/i);
        if (match) milkChange = parseInt(match[1]);
      }

      if (/Added Eggs/i.test(desc)) {
        const match = desc.match(/Added Eggs .* : (\d+)/i);
        if (match) eggsChange = parseInt(match[1]);
      }

      if (/Added Cattle/i.test(desc)) {
        const match = desc.match(/Added Cattle .* : (\d+)/i);
        if (match) cattleChange = parseInt(match[1]);
      }

      // Upsert the user in DB
      await pool.query(
        `INSERT INTO ranch_stats (username, milk, eggs, cattle)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO UPDATE
         SET milk = ranch_stats.milk + $2,
             eggs = ranch_stats.eggs + $3,
             cattle = ranch_stats.cattle + $4`,
        [username, milkChange, eggsChange, cattleChange]
      );
    }

    await updateLeaderboard();
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
});

// ---------------------
// Start Express Server
// ---------------------
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
