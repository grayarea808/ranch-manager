// ---------------------
// Imports
// ---------------------
import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { Client, GatewayIntentBits } from 'discord.js';

// ---------------------
// PostgreSQL Setup
// ---------------------
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  ssl: { rejectUnauthorized: false } // Required on Railway
});

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express Webhook Server
// ---------------------
const app = express();
app.use(express.json());

app.post('/webhook/ranch', async (req, res) => {
  console.log('📩 Webhook received!', JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

    // Parse username and stat from payload
    const username = data.username;
    const description = data.embeds?.[0]?.description || '';

    let milkAdded = 0, eggsAdded = 0, cattleAdded = 0;

    const milkMatch = description.match(/Added Milk.*: (\d+)/i);
    const eggsMatch = description.match(/Added Eggs.*: (\d+)/i);
    const cattleMatch = description.match(/Added Cattle.*: (\d+)/i);

    if (milkMatch) milkAdded = parseInt(milkMatch[1]);
    if (eggsMatch) eggsAdded = parseInt(eggsMatch[1]);
    if (cattleMatch) cattleAdded = parseInt(cattleMatch[1]);

    // Upsert into PostgreSQL
    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle
    `, [username, milkAdded, eggsAdded, cattleAdded]);

    console.log(`Updated stats for ${username}: Milk ${milkAdded}, Eggs ${eggsAdded}, Cattle ${cattleAdded}`);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Start webhook server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// ---------------------
// Leaderboard Function
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, (milk*1.1 + eggs*1.1 + cattle) AS total
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
// Discord Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord login failed:', err));
