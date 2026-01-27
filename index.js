import express from "express";
import bodyParser from "body-parser";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const app = express();
app.use(bodyParser.json());

const PORT = 8080;

// Prices
const MILK_PRICE = 1.25;
const EGGS_PRICE = 1.25;
const CATTLE_PRICE = 160;

// Discord setup
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel]
});

const LEADERBOARD_CHANNEL_ID = "1465062014626824347"; // Your channel ID
let leaderboardMessageId = null; // We'll store the message ID here
const players = {}; // userID => stats

// Helper to calculate total value
function calculateTotal(player) {
    return (player.milk * MILK_PRICE) +
           (player.eggs * EGGS_PRICE) +
           (player.soldCattle * CATTLE_PRICE);
}

// Build leaderboard text
function buildLeaderboard() {
    let text = "🏆 Beaver Farms — Leaderboard\n\n";
    for (const id in players) {
        const p = players[id];
        text += `<@${id}> ${p.username}\n`;
        text += `🥛 Milk: ${p.milk}\n`;
        text += `🥚 Eggs: ${p.eggs}\n`;
        text += `🐄 Cattle: ${p.cattle} (+${p.soldCattle} sold)\n`;
        text += `💰 Total: $${calculateTotal(p).toFixed(2)}\n\n`;
    }
    return text;
}

// Update leaderboard message (send if first time, edit if exists)
async function updateLeaderboard() {
    try {
        const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
        const content = buildLeaderboard();

        if (!leaderboardMessageId) {
            const msg = await channel.send(content);
            leaderboardMessageId = msg.id;
        } else {
            const msg = await channel.messages.fetch(leaderboardMessageId);
            await msg.edit(content);
        }

        console.log("✅ Leaderboard updated!");
    } catch (err) {
        console.error("❌ Error updating leaderboard:", err);
    }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
    const data = req.body;
    if (!data.id || !data.username) {
        return res.status(400).send("Missing id or username");
    }

    // Initialize player if new
    if (!players[data.id]) {
        players[data.id] = {
            username: data.username,
            milk: 0,
            eggs: 0,
            cattle: 0,
            soldCattle: 0
        };
    }

    // Update stats
    if (data.milk) players[data.id].milk += data.milk;
    if (data.eggs) players[data.id].eggs += data.eggs;
    if (data.cattle) players[data.id].cattle += data.cattle;
    if (data.soldCattle) {
        players[data.id].soldCattle += data.soldCattle;
        players[data.id].cattle -= data.soldCattle;
        if (players[data.id].cattle < 0) players[data.id].cattle = 0;
    }

    await updateLeaderboard();
    res.sendStatus(200);
});

// Start Express
app.listen(PORT, () => {
    console.log(`🚀 Webhook running on port ${PORT}`);
});

// Discord login
client.once("ready", () => {
    console.log(`🚜 Ranch Manager running as ${client.user.tag}`);
});

client.login("YOUR_DISCORD_BOT_TOKEN");
