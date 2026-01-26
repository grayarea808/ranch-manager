import express from 'express';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const pool = new pg.Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const LEADERBOARD_RESET_TABLE = 'leaderboard_reset'; // table to track weekly reset
const RANCH_STATS_TABLE = 'ranch_stats';

// Ensure tables exist
await pool.query(`
CREATE TABLE IF NOT EXISTS ${RANCH_STATS_TABLE} (
  username TEXT PRIMARY KEY,
  milk INT DEFAULT 0,
  eggs INT DEFAULT 0,
  cattle INT DEFAULT 0
);
`);
await pool.query(`
CREATE TABLE IF NOT EXISTS ${LEADERBOARD_RESET_TABLE} (
  last_reset TIMESTAMP
);
`);
await pool.query(`
INSERT INTO ${LEADERBOARD_RESET_TABLE}(last_reset)
SELECT NOW() WHERE NOT EXISTS (SELECT 1 FROM ${LEADERBOARD_RESET_TABLE});
`);

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await updateLeaderboard();
  setInterval(updateLeaderboard, 60 * 1000); // refresh every minute
});

app.post('/webhook/ranch', async (req, res) => {
  const data = req.body;
  console.log('📩 Webhook received!', data);

  if (!data.username) return res.sendStatus(400);

  // Extract counts
  const milk = data.milk ?? 0;
  const eggs = data.eggs ?? 0;
  const cattle = data.cattle ?? 0;

  // Upsert user
  await pool.query(`
    INSERT INTO ${RANCH_STATS_TABLE}(username, milk, eggs, cattle)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(username) DO UPDATE
    SET milk = ${RANCH_STATS_TABLE}.milk + EXCLUDED.milk,
        eggs = ${RANCH_STATS_TABLE}.eggs + EXCLUDED.eggs,
        cattle = ${RANCH_STATS_TABLE}.cattle + EXCLUDED.cattle
  `, [data.username, milk, eggs, cattle]);

  res.sendStatus(200);
});

async function resetLeaderboardIfNeeded() {
  const { rows } = await pool.query(`SELECT last_reset FROM ${LEADERBOARD_RESET_TABLE} LIMIT 1`);
  const lastReset = rows[0]?.last_reset ?? new Date(0);
  const now = new Date();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  if (now - new Date(lastReset) > oneWeek) {
    await pool.query(`UPDATE ${RANCH_STATS_TABLE} SET milk=0, eggs=0, cattle=0`);
    await pool.query(`UPDATE ${LEADERBOARD_RESET_TABLE} SET last_reset=NOW()`);
    console.log('🕒 Leaderboard reset for new week!');
  }
}

async function updateLeaderboard() {
  try {
    await resetLeaderboardIfNeeded();

    const result = await pool.query(`SELECT * FROM ${RANCH_STATS_TABLE}`);
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.log('Channel not found');

    // Clear old leaderboard messages
    const messages = await channel.messages.fetch({ limit: 50 });
    messages.forEach(msg => {
      if (msg.content.includes('🏆 Beaver Farms — Leaderboard')) msg.delete().catch(() => {});
    });

    let leaderboardText = '';
    for (const row of result.rows) {
      const milkValue = (row.milk ?? 0) * 1.25;
      const eggsValue = (row.eggs ?? 0) * 1.25;
      const cattleValue = (row.cattle ?? 0) * 160; // 200 - 20% ranch cut
      const total = milkValue + eggsValue + cattleValue;

      leaderboardText += `\n${row.username}\n🥛 Milk: ${row.milk ?? 0}\n🥚 Eggs: ${row.eggs ?? 0}\n🐄 Cattle: ${row.cattle ?? 0}\n💰 Total: $${total.toFixed(2)}\n`;
    }

    const embed = new EmbedBuilder()
      .setTitle('🏆 Beaver Farms — Leaderboard')
      .setDescription(leaderboardText)
      .setColor(0x00ff00);

    await channel.send({ embeds: [embed] });
    console.log('Leaderboard updated!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

client.login(process.env.DISCORD_TOKEN);

app.listen(8080, () => {
  console.log('Webhook server listening on port 8080');
});
