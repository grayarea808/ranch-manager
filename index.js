import express from 'express';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const { Pool } = pkg;

/* ======================
   CONFIG
====================== */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = '1465062014626824347';
const PORT = process.env.PORT || 3000;

/* ======================
   DATABASE
====================== */
const pool = new Pool({
  host: 'postgres.railway.internal',
  user: 'postgres',
  password: 'YOUR_DB_PASSWORD',
  database: 'railway',
  port: 5432,
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS ranch (
    username TEXT PRIMARY KEY,
    milk INT DEFAULT 0,
    eggs INT DEFAULT 0,
    cattle INT DEFAULT 0,
    total INT DEFAULT 0
  );
`);

/* ======================
   DISCORD
====================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let leaderboardMessageId = null;

/* ======================
   LEADERBOARD
====================== */
async function updateLeaderboard() {
  const res = await pool.query(`
    SELECT * FROM ranch
    ORDER BY total DESC
  `);

  let text = '🏆 **Beaver Farms — Weekly Leaderboard**\n\n';

  if (res.rows.length === 0) {
    text += 'No activity yet.';
  } else {
    for (const row of res.rows) {
      text += `**${row.username}**\n`;
      text += `🥛 Milk: ${row.milk}\n`;
      text += `🥚 Eggs: ${row.eggs}\n`;
      text += `🐄 Cattle: ${row.cattle}\n`;
      text += `💰 Total: $${Number(row.total)}\n\n`;
    }
  }

  const channel = await client.channels.fetch(CHANNEL_ID);

  if (leaderboardMessageId) {
    const msg = await channel.messages.fetch(leaderboardMessageId);
    await msg.edit(text);
  } else {
    const msg = await channel.send(text);
    leaderboardMessageId = msg.id;
  }
}

/* ======================
   WEBHOOK SERVER
====================== */
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  const { username, item, amount } = req.body;

  if (!username || !['milk', 'eggs', 'cattle'].includes(item)) {
    return res.status(400).send('Invalid payload');
  }

  const qty = Number(amount) || 0;

  await pool.query(`
    INSERT INTO ranch (username, ${item}, total)
    VALUES ($1, $2, $2)
    ON CONFLICT (username)
    DO UPDATE SET
      ${item} = ranch.${item} + $2,
      total = ranch.total + $2;
  `, [username, qty]);

  await updateLeaderboard();
  res.send('OK');
});

/* ======================
   WEEKLY RESET (SUNDAYS 12AM)
====================== */
cron.schedule('0 0 * * 0', async () => {
  console.log('Weekly reset running...');
  await pool.query(`TRUNCATE TABLE ranch;`);
  await updateLeaderboard();
});

/* ======================
   READY
====================== */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });

  const old = messages.find(
    m => m.author.id === client.user.id && m.content.includes('Beaver Farms')
  );

  if (old) leaderboardMessageId = old.id;
  await updateLeaderboard();
});

/* ======================
   START
====================== */
client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`Webhook listening on ${PORT}`));
