// index.js
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const app = express();
const PORT = process.env.PORT || 8080;

// PostgreSQL connection
const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT,
});

// Middleware to parse JSON
app.use(bodyParser.json());

let leaderboardMessageId; // Stores the message ID for editing

// Webhook endpoint
app.post('/ranch-webhook', async (req, res) => {
    const { userId, action, amount, playerName } = req.body;

    if (!userId || !action || amount == null || !playerName) {
        return res.status(400).send({ error: 'Missing fields in request body' });
    }

    try {
        // Insert/update player stats in PostgreSQL
        await pool.query(`
            INSERT INTO ranch_stats (user_id, player_name, action, amount)
            VALUES ($1, $2, $3, $4)
        `, [userId, playerName, action, amount]);

        // Update the leaderboard after each webhook
        await updateLeaderboard();

        res.status(200).send({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send({ error: 'Database error' });
    }
});

// Function to update leaderboard
async function updateLeaderboard() {
    try {
        const res = await pool.query(`
            SELECT player_name,
                   SUM(CASE WHEN action='milk' THEN amount ELSE 0 END) AS milk,
                   SUM(CASE WHEN action='eggs' THEN amount ELSE 0 END) AS eggs,
                   SUM(CASE WHEN action='cattle' THEN amount ELSE 0 END) AS cattle
            FROM ranch_stats
            GROUP BY player_name
            ORDER BY milk + eggs + cattle DESC
            LIMIT 10;
        `);

        if (!res.rows.length) return;

        let totalRanchProfit = 0;

        const leaderboardText = res.rows.map(row => {
            const milkValue = (row.milk * 1.1).toFixed(2);
            const eggsValue = (row.eggs * 1.1).toFixed(2);
            const cattleValue = row.cattle.toFixed(2);
            const total = (parseFloat(milkValue) + parseFloat(eggsValue) + parseFloat(cattleValue)).toFixed(2);

            totalRanchProfit += parseFloat(total);

            return `**${row.player_name}**\n🥛 Milk: ${row.milk} → $${milkValue}\n🥚 Eggs: ${row.eggs} → $${eggsValue}\n🐄 Cattle: $${cattleValue}\n💰 Total: $${total}`;
        }).join('\n\n');

        const channel = await client.channels.fetch(process.env.LEADERBOARD_CHANNEL_ID);
        const header = `🏆 Baba Yaga Ranch — Page 1/1\n📅 Next Ranch Payout: Saturday, Jan 31\n💰 Ranch Payout\n$${totalRanchProfit.toFixed(2)}\n`;

        if (leaderboardMessageId) {
            const msg = await channel.messages.fetch(leaderboardMessageId).catch(() => null);
            if (msg) {
                msg.edit({ content: `${header}\n${leaderboardText}` });
                return;
            }
        }

        const newMsg = await channel.send(`${header}\n${leaderboardText}`);
        leaderboardMessageId = newMsg.id;

    } catch (err) {
        console.error('Failed to update leaderboard:', err);
    }
}

// Start Express server
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));

// Login Discord client
client.once('clientReady', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.BOT_TOKEN);

// Optional: periodic leaderboard update (every 1 minute)
setInterval(updateLeaderboard, 60 * 1000);
