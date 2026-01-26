// ---------------------
// Imports
// ---------------------
import express from 'express';
import pkg from 'pg';
import { Client, GatewayIntentBits } from 'discord.js';
const { Pool } = pkg;

// ---------------------
// PostgreSQL Setup
// ---------------------
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  ssl: { rejectUnauthorized: false } // Required for Railway
});

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express Setup
// ---------------------
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, 
             (milk * 1.25 + eggs * 1.25 + cattle) AS total
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
      leaderboardMessage += `💰 Total: $${Number(row.total).toFixed(2)}\n\n`;
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
// Discord Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

// ---------------------
// Webhook Endpoint
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    console.log('📩 Webhook received!', req.body);

    // Example payload parsing
    const data = req.body;
    const username = data.username.split(' ')[2] || 'Unknown'; // adjust based on your webhook payload
    const description = data.embeds?.[0]?.description || '';

    let milkAdded = 0;
    let eggsAdded = 0;
    let cattleAdded = 0;

    // Parse amounts from description
    const milkMatch = description.match(/Milk.*?(\d+)/i);
    const eggsMatch = description.match(/Eggs.*?(\d+)/i);
    const cattleMatch = description.match(/Cattle.*?(\d+)/i);

    if (milkMatch) milkAdded = parseInt(milkMatch[1]);
    if (eggsMatch) eggsAdded = parseInt(eggsMatch[1]);
    if (cattleMatch) cattleAdded = parseInt(cattleMatch[1]);

    // Insert new row if username doesn't exist
    await pool.query(`
      INSERT INTO ranch_stats(username, milk, eggs, cattle)
      VALUES($1, 0, 0, 0)
      ON CONFLICT (username) DO NOTHING
    `, [username]);

    // Update totals
    await pool.query(`
      UPDATE ranch_stats
      SET milk = milk + $2,
          eggs = eggs + $3,
          cattle = cattle + $4
      WHERE username = $1
    `, [username, milkAdded, eggsAdded, cattleAdded]);

    await updateLeaderboard();
    res.status(200).send('Webhook processed!');
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).send('Error');
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
client.login(process.env.DISCORD_TOKEN)
  .catch(err => console.error('Failed to login Discord bot:', err));
