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

// Discord client
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel]
});

const LEADERBOARD_CHANNEL_ID = "1465062014626824347";
let leaderboardMessageId = null;

// Player storage
const players = {};

// ---- Helpers ----
function getPlayer(id, username = "Unknown") {
    if (!players[id]) {
        players[id] = {
            username,
            milk: 0,
            eggs: 0,
            cattle: 0,
            soldCattle: 0
        };
    }
    return players[id];
}

function calculateTotal(p) {
    return (
        p.milk * MILK_PRICE +
        p.eggs * EGGS_PRICE +
        p.soldCattle * CATTLE_PRICE
    );
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
            console.log("📌 Leaderboard message created:", leaderboardMessageId);
        } else {
            const msg = await channel.messages.fetch(leaderboardMessageId);
            await msg.edit(content);
            console.log("🔁 Leaderboard updated");
        }
    } catch (err) {
        console.error("❌ Leaderboard update error:", err.message);
    }
}

// ---- WEBHOOK (THIS IS THE IMPORTANT PART) ----
app.post("/webhook", async (req, res) => {
    console.log("🔥 WEBHOOK RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    const data = req.body;

    // Accept MULTIPLE RedM / test formats
    const id =
        data.id ||
        data.discordId ||
        data.discord ||
        data.playerDiscord;

    const username =
        data.username ||
        data.name ||
        data.playerName ||
        "Unknown";

    if (!id) {
        console.log("⚠️ Missing Discord ID — ignoring payload");
        return res.sendStatus(200);
    }

    const player = getPlayer(id, username);

    // Increment-safe updates
    if (Number.isFinite(data.milk)) player.milk += Number(data.milk);
    if (Number.isFinite(data.eggs)) player.eggs += Number(data.eggs);
    if (Number.isFinite(data.cattle)) player.cattle += Number(data.cattle);

    if (Number.isFinite(data.soldCattle)) {
        player.soldCattle += Number(data.soldCattle);
        player.cattle -= Number(data.soldCattle);
        if (player.cattle < 0) player.cattle = 0;
    }

    await updateLeaderboard();
    res.sendStatus(200);
});

// ---- START ----
app.listen(PORT, () => {
    console.log(`🚀 Webhook listening on port ${PORT}`);
});

client.once("ready", () => {
    console.log(`🤠 Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
