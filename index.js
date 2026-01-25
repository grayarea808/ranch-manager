require('dotenv').config(); // Load .env first

const { Client, GatewayIntentBits } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const app = express();

app.use(express.json());

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT
});

// Connect Discord
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Listen to webhook
app.post('/ranch-webhook', async (req, res) => {
    const { userId, action, amount, playerName } = req.body;

    // Save to database
    try {
        await pool.query(
            'INSERT INTO ranch_stats(user_id, player_name, action, amount) VALUES($1,$2,$3,$4)',
            [userId, playerName, action, amount]
        );

        console.log(`Updated ${playerName}: ${action} +${amount}`);
        res.status(200).send('Success');
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error');
    }
});

// Update leaderboard every 1 minute
async function updateLeaderboard() {
    try {
        const result = await pool.query(`
            SELECT player_name,
                   SUM(CASE WHEN action='milk' THEN amount ELSE 0 END) AS milk,
                   SUM(CASE WHEN action='eggs' THEN amount ELSE 0 END) AS eggs
            FROM ranch_stats
            GROUP BY player_name
            ORDER BY milk + eggs DESC
            LIMIT 10
        `);

        const channel = client.channels.cache.get('YOUR_CHANNEL_ID'); // Replace with channel ID

        if (!channel) return console.log('Leaderboard channel not found');

        let message = '🏆 Baba Yaga Ranch — Page 1/1\n';
        result.rows.forEach(row => {
            message += `${row.player_name}\n🥛 Milk: ${row.milk}\n🥚 Eggs: ${row.eggs}\n\n`;
        });

        await channel.send(message);
    } catch (err) {
        console.error(err);
    }
}

// Update leaderboard every minute
setInterval(updateLeaderboard, 60 * 1000);

client.login(process.env.BOT_TOKEN);

// Start webhook server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
