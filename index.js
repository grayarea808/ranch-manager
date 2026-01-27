import express from "express";
import bodyParser from "body-parser";
import { Client, GatewayIntentBits, Partials } from "discord.js";

// ================== CONFIG ==================
const PORT = 8080;
const LEADERBOARD_CHANNEL_ID = "1465062014626824347";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Prices
const MILK_PRICE = 1.25;
const EGGS_PRICE = 1.25;
const CATTLE_PRICE = 160;

// ================== EXPRESS ==================
const app = express();
app.use(bodyParser.json());

// ================== DISCORD ==================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel]
});

let leaderboardMessageId = null;
const players = {}; // discordId => stats

client.once("clientReady", () => {
    console.log(`🚜 Ranch Manager running as ${client.user.tag}`);
});

// ================== HELPERS ==================
function calculateTotal(p) {
    return (p.milk * MILK_PRICE) +
           (p.eggs * EGGS_PRICE) +
           (p.soldCattle * CATTLE_PRICE);
}

function buildLeaderboard() {
    let text = "🏆 **Beaver Farms — Leaderboard**\n\n";

    for (const id in players) {
        const p = players[id];
        text += `<@${id}> **${p.username}**\n`;
        text += `🥛 Milk: ${p.milk}\n`;
        text += `🥚 Eggs: ${p.eggs}\n`;
        text += `🐄 Cattle: ${p.cattle} (+${p.soldCattle} sold)\n`;
        text += `💰 Total: $${calculateTotal(p).toFixed(2)}\n\n`;
    }

    return text;
}

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

        console.log("✅ Leaderboard updated");
    } catch (err) {
        console.error("❌ Error updating leaderboard:", err.code || err.message);
    }
}

// ================== WEBHOOK ==================
app.post("/webhook", async (req, res) => {
    let data = req.body;

    // 🔴 RedM often sends stringified JSON
    if (typeof data.data === "string") {
        try {
            data = JSON.parse(data.data);
        } catch {
            console.error("❌ Failed to parse RedM payload");
        }
    }

    console.log("⚡ RedM webhook:", data);

    const id =
        data.id ||
        data.playerId ||
        data.discord ||
        data.discordId;

    const username =
        data.username ||
        data.playerName ||
        data.name;

    if (!id || !username) {
        console.warn("⚠️ Missing Discord ID or username");
        return res.sendStatus(200);
    }

    if (!players[id]) {
        players[id] = {
            username,
            milk: 0,
            eggs: 0,
            cattle: 0,
            soldCattle: 0
        };
    }

    const amount = Number(data.amount || data.count || 1);

    // 🥛 MILK
    if (data.item === "milk" || data.event === "cow_milked") {
        players[id].milk += amount;
    }

    // 🥚 EGGS
    if (data.item === "egg" || data.event === "chicken_eggs") {
        players[id].eggs += amount;
    }

    // 🐄 BUY CATTLE
    if (data.event === "buy_cattle") {
        players[id].cattle += amount;
    }

    // 🐄 SELL CATTLE
    if (data.event === "sell_cattle") {
        players[id].soldCattle += amount;
        players[id].cattle = Math.max(
            0,
            players[id].cattle - amount
        );
    }

    await updateLeaderboard();
    res.sendStatus(200);
});

// ================== START ==================
app.listen(PORT, () => {
    console.log(`🚀 Webhook listening on port ${PORT}`);
});

client.login(DISCORD_TOKEN);
