import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pkg from 'pg';
import express from 'express';

const { Pool } = pkg;

/* =======================
   DATABASE
======================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =======================
   DISCORD CLIENT
======================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =======================
   EXPRESS (WEBHOOK)
======================= */
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

/* =======================
   LEADERBOARD UPDATE
======================= */
async function updateLeaderboard() {
  const { rows } = await pool.query(`
    SELECT username, total
    FROM leaderboard
    ORDER BY total DESC
    LIMIT 10
  `);

  const description = rows.length
    ? rows.map((r, i) => `**${i + 1}. ${r.username}** — ${Number(r.total)}`).join('\n')
    : 'No data yet.';

  const embed = new EmbedBuilder()
    .setTitle('🐮 Beaver Farms — Leaderboard')
    .setDescription(description)
    .setColor(0x8b4513)
    .setTimestamp();

  const channel = await client.channels.fetch(process.env.LEADERBOARD_CHANNEL_ID);
  const message = await channel.messages.fetch(process.env.LEADERBOARD_MESSAGE_ID);

  await message.edit({ embeds: [embed] });
  console.log('📊 Leaderboard updated');
}

/* =======================
   WEBHOOK ENDPOINT
======================= */
app.post('/webhook', async (req, res) => {
  try {
    const { user_id, username, milk = 0, eggs = 0, cattle = 0 } = req.body;

    await pool.query(`
      INSERT INTO leaderboard (user_id, username, milk, eggs, cattle, total)
      VALUES ($1, $2, $3, $4, $5, $3+$4+$5)
      ON CONFLICT (user_id)
      DO UPDATE SET
        milk = leaderboard.milk + EXCLUDED.milk,
        eggs = leaderboard.eggs + EXCLUDED.eggs,
        cattle = leaderboard.cattle + EXCLUDED.cattle,
        total = leaderboard.total + EXCLUDED.total,
        last_updated = NOW()
    `, [user_id, username, milk, eggs, cattle]);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* =======================
   WEEKLY RESET (NO CRON)
======================= */
async function checkWeeklyReset() {
  const now = new Date();

  const isSunday = now.getDay() === 0;
  const isMidnight = now.getHours() === 0 && now.getMinutes() === 0;
  if (!isSunday || !isMidnight) return;

  const { rows } = await pool.query(
    `SELECT value FROM system_state WHERE key='last_reset'`
  );

  const lastReset = new Date(rows[0].value);
  const diffDays = (now - lastReset) / (1000 * 60 * 60 * 24);
  if (diffDays < 6) return;

  console.log('🔁 WEEKLY RESET');

  await pool.query(`
    UPDATE leaderboard
    SET milk=0, eggs=0, cattle=0, total=0
  `);

  await pool.query(`
    UPDATE system_state
    SET value=$1
    WHERE key='last_reset'
  `, [now.toISOString().slice(0, 10)]);

  await updateLeaderboard();
}

setInterval(checkWeeklyReset, 60 * 1000);

/* =======================
   BOT READY
======================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await updateLeaderboard();
});

/* =======================
   START
======================= */
client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🚜 Ranch Manager running on port ${PORT}`);
});
