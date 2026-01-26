import 'dotenv/config';
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import express from 'express';
import pg from 'pg';

const app = express();
app.use(express.json());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const pool = new pg.Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

async function updateLeaderboard() {
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel.isTextBased()) return;

    // 1️⃣ Delete previous leaderboard messages
    const messages = await channel.messages.fetch({ limit: 50 });
    messages.forEach(msg => {
      if (msg.content.includes('🏆 Beaver Farms — Leaderboard')) {
        msg.delete().catch(console.error);
      }
    });

    // 2️⃣ Fetch leaderboard data
    const result = await pool.query('SELECT username, milk, eggs, cattle FROM ranch_stats;');

    // 3️⃣ Combine duplicates per username
    const combined = {};
    result.rows.forEach(row => {
      if (!combined[row.username]) {
        combined[row.username] = { milk: 0, eggs: 0, cattle: 0 };
      }
      combined[row.username].milk += Number(row.milk);
      combined[row.username].eggs += Number(row.eggs);
      combined[row.username].cattle += Number(row.cattle);
    });

    // 4️⃣ Build leaderboard string
    let leaderboardText = '🏆 Beaver Farms — Leaderboard\n\n';
    for (const [username, stats] of Object.entries(combined)) {
      const total = (stats.milk * 1.25) + (stats.eggs * 1.25) + (stats.cattle * 160); // $160 per cattle
      leaderboardText += `${username}\n🥛 Milk: ${stats.milk}\n🥚 Eggs: ${stats.eggs}\n🐄 Cattle: ${stats.cattle}\n💰 Total: $${total.toFixed(2)}\n\n`;
    }

    await (channel as TextChannel).send(leaderboardText);
    console.log('Leaderboard updated!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// Example: update leaderboard every 5 minutes
setInterval(updateLeaderboard, 5 * 60 * 1000);

// Webhook endpoint
app.post('/webhook/ranch', async (req, res) => {
  console.log('📩 Webhook received!', req.body);
  // TODO: Add DB update logic based on webhook payload here
  await updateLeaderboard();
  res.sendStatus(200);
});

client.login(process.env.DISCORD_TOKEN);

app.listen(8080, () => console.log('Webhook server listening on port 8080'));
