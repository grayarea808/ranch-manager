import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';
import pg from 'pg';

const app = express();
app.use(express.json());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const pool = new pg.Pool({
  user: 'YOUR_PG_USER',
  host: 'YOUR_PG_HOST',
  database: 'YOUR_PG_DATABASE',
  password: 'YOUR_PG_PASSWORD',
  port: 5432,
});

const channelId = 'YOUR_CHANNEL_ID'; // Discord channel where leaderboard is posted

// -------------------------
// Ensure table exists to store leaderboard message ID
// -------------------------
await pool.query(`
CREATE TABLE IF NOT EXISTS leaderboard_meta (
  id SERIAL PRIMARY KEY,
  message_id TEXT
);
`);

// -------------------------
// Reset leaderboard weekly
// -------------------------
await pool.query(`
CREATE TABLE IF NOT EXISTS leaderboard_reset (
  id SERIAL PRIMARY KEY,
  last_reset TIMESTAMP NOT NULL
);
`);

async function resetLeaderboardIfNeeded() {
  const res = await pool.query('SELECT last_reset FROM leaderboard_reset ORDER BY last_reset DESC LIMIT 1');
  const now = new Date();

  if (!res.rows[0] || (now - new Date(res.rows[0].last_reset)) > 7 * 24 * 60 * 60 * 1000) {
    console.log('Resetting leaderboard for new week...');
    await pool.query('UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0');
    if (res.rows[0]) {
      await pool.query('UPDATE leaderboard_reset SET last_reset = $1 WHERE id = $2', [now, res.rows[0].id]);
    } else {
      await pool.query('INSERT INTO leaderboard_reset(last_reset) VALUES($1)', [now]);
    }
  }
}

// -------------------------
// Update leaderboard message
// -------------------------
async function updateLeaderboardMessage() {
  await resetLeaderboardIfNeeded();

  const result = await pool.query('SELECT username, milk, eggs, cattle FROM ranch_stats ORDER BY (milk*1.25 + eggs*1.25 + cattle*160) DESC');

  let leaderboardText = '🏆 Beaver Farms — Leaderboard\n\n';
  result.rows.forEach(row => {
    const total = (row.milk * 1.25) + (row.eggs * 1.25) + (row.cattle * 160);
    leaderboardText += `${row.username}\n🥛 Milk: ${row.milk}\n🥚 Eggs: ${row.eggs}\n🐄 Cattle: ${row.cattle}\n💰 Total: $${total.toFixed(2)}\n\n`;
  });

  const channel = await client.channels.fetch(channelId);

  // Fetch the stored leaderboard message ID from DB
  let msgRes = await pool.query('SELECT message_id FROM leaderboard_meta ORDER BY id DESC LIMIT 1');
  let leaderboardMessageId = msgRes.rows[0]?.message_id;

  if (leaderboardMessageId) {
    try {
      const message = await channel.messages.fetch(leaderboardMessageId);
      await message.edit(leaderboardText);
      console.log('Leaderboard updated (edited existing message)!');
      return;
    } catch (err) {
      console.log('Previous message not found, creating new one...');
    }
  }

  // Post a new message and store its ID
  const message = await channel.send(leaderboardText);
  await message.pin();
  await pool.query('INSERT INTO leaderboard_meta(message_id) VALUES($1)', [message.id]);
  console.log('New leaderboard posted and pinned!');
}

// -------------------------
// Webhook endpoint
// -------------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;
    const username = data.username.split(' ')[2] || data.username;

    const eggsAdded = data.embeds?.[0]?.description.match(/Added Eggs.*: (\d+)/)?.[1] || 0;
    const milkAdded = data.embeds?.[0]?.description.match(/Added Milk.*: (\d+)/)?.[1] || 0;
    const cattleAdded = data.embeds?.[0]?.description.match(/Added Cattle.*: (\d+)/)?.[1] || 0;

    await pool.query(
      'UPDATE ranch_stats SET milk = milk + $1, eggs = eggs + $2, cattle = cattle + $3 WHERE username = $4',
      [milkAdded, eggsAdded, cattleAdded, username]
    );

    await updateLeaderboardMessage();

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

app.listen(8080, () => console.log('Webhook server listening on port 8080'));

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login('YOUR_DISCORD_TOKEN');
