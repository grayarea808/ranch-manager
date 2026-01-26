import { Client, GatewayIntentBits, Events } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// --------------------
// RAILWAY VARIABLES
// --------------------
const CHANNEL_ID = '1465062014626824347'; // Discord channel ID
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // Railway token variable
const PGHOST = 'postgres.railway.internal';
const PGUSER = 'postgres';
const PGPASSWORD = 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA';
const PGDATABASE = 'railway';
const PGPORT = 5432;

// --------------------
// POSTGRES SETUP
// --------------------
const pool = new Pool({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT,
});

// Ensure leaderboard table exists
await pool.query(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    username TEXT PRIMARY KEY,
    milk INT DEFAULT 0,
    eggs INT DEFAULT 0,
    cattle INT DEFAULT 0,
    total INT DEFAULT 0
  );
`);

// --------------------
// DISCORD SETUP
// --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], // allowed intents only
});

let leaderboardMessageId = null;

// --------------------
// UPDATE LEADERBOARD
// --------------------
async function updateLeaderboard() {
  try {
    const res = await pool.query(`
      SELECT username, milk, eggs, cattle, total
      FROM leaderboard
      ORDER BY total DESC
      LIMIT 10
    `);

    let content = '🏆 Beaver Farms — Leaderboard\n\n';
    if (res.rows.length === 0) {
      content += 'No data yet.';
    } else {
      for (const row of res.rows) {
        const total = Number(row.total) || 0; // safe number
        content += `${row.username.toUpperCase()}\n`;
        content += `🥛 Milk: ${row.milk}\n`;
        content += `🥚 Eggs: ${row.eggs}\n`;
        content += `🐄 Cattle: ${row.cattle}\n`;
        content += `💰 Total: $${total.toFixed(2)}\n\n`;
      }
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    if (leaderboardMessageId) {
      // edit existing message
      const msg = await channel.messages.fetch(leaderboardMessageId);
      await msg.edit(content);
    } else {
      // create new message
      const msg = await channel.send(content);
      leaderboardMessageId = msg.id;
    }
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// --------------------
// HANDLE WEBHOOK UPDATES
// --------------------
// Example: webhook sends { username, item, amount }
async function handleWebhook(data) {
  const { username, item, amount } = data;
  if (!['milk', 'eggs', 'cattle'].includes(item)) return;
  if (!username || isNaN(amount)) return;

  await pool.query(`
    INSERT INTO leaderboard (username, ${item}, total)
    VALUES ($1, $2, $2)
    ON CONFLICT (username)
    DO UPDATE SET
      ${item} = leaderboard.${item} + EXCLUDED.${item},
      total = (COALESCE(leaderboard.milk,0) + COALESCE(leaderboard.eggs,0) + COALESCE(leaderboard.cattle,0) +
               CASE WHEN $3 = 'milk' THEN $2 ELSE 0 END +
               CASE WHEN $3 = 'eggs' THEN $2 ELSE 0 END +
               CASE WHEN $3 = 'cattle' THEN $2 ELSE 0 END
              );
  `, [username, amount, item]);

  await updateLeaderboard();
}

// --------------------
// CLIENT READY
// --------------------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });
  const lastLeaderboard = messages.find(
    msg => msg.author.id === client.user.id && msg.content.startsWith('🏆 Beaver Farms — Leaderboard')
  );
  if (lastLeaderboard) leaderboardMessageId = lastLeaderboard.id;

  if (!leaderboardMessageId) {
    const msg = await channel.send('🏆 Beaver Farms — Leaderboard\nFetching data...');
    leaderboardMessageId = msg.id;
  }

  await updateLeaderboard();
});

// --------------------
// LOGIN
// --------------------
client.login(DISCORD_TOKEN);

// --------------------
// EXPORT FOR WEBHOOK
// --------------------
export { handleWebhook };
