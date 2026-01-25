// index.js
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

// ---------- Discord Client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);

// ---------- PostgreSQL Connection ----------
const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT,
    ssl: { rejectUnauthorized: false } // needed for Railway
});

// ---------- Create Table if Not Exists ----------
(async () => {
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS ranch_stats (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        action TEXT NOT NULL,
        amount INT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;
    await pool.query(createTableQuery);
    console.log('Database table ready');
})();

// ---------- Webhook Endpoint ----------
app.post('/ranch-webhook', async (req, res) => {
    try {
        const { userId, playerName, action, amount } = req.body;

        if (!userId || !playerName || !action || !amount) {
            return res.status(400).send('Missing required fields');
        }

        // Insert into database
        await pool.query(
            'INSERT INTO ranch_stats (user_id, player_name, action, amount) VALUES ($1, $2, $3, $4)',
            [userId, playerName, action, amount]
        );

        console.log(`Ranch webhook received: ${JSON.stringify(req.body)}`);

        // Send confirmation to Discord (optional)
        const user = await client.users.fetch(userId);
        user.send(`You added **${amount} ${action}** to your ranch!`);

        res.status(200).send('Webhook received');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
