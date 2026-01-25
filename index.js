// index.js
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits } = require("discord.js");

// ---- Discord setup ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const BOT_TOKEN = process.env.BOT_TOKEN;

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(BOT_TOKEN);

// ---- Express setup ----
const app = express();
app.use(bodyParser.json()); // Parse JSON POSTs

// ---- In-memory ranch stats ----
const ranchStats = {};

// ---- Webhook endpoint ----
app.post("/ranch-webhook", (req, res) => {
  const data = req.body;

  let userId, action, amount, playerName;

  // Syn County webhook (embeds)
  if (data.embeds && data.embeds.length > 0) {
    const desc = data.embeds[0].description; // "<@123456789> 10 GRAYAREA"
    const match = desc.match(/<@(\d+)> (\d+) (\w+)/);
    if (match) {
      userId = match[1];
      amount = parseInt(match[2]);
      playerName = match[3];
      action = data.embeds[0].title.toLowerCase().includes("egg") ? "eggs" : "milk";
    }
  }

  // Manual JSON
  if (data.userId && data.action && data.amount && data.playerName) {
    userId = data.userId;
    action = data.action.toLowerCase();
    amount = parseInt(data.amount);
    playerName = data.playerName;
  }

  if (!userId || !action || !amount || !playerName) {
    return res.status(400).send("Bad Request: Missing required fields");
  }

  console.log(`Received ${action} update for ${playerName} (${userId}): ${amount}`);

  // Update stats
  if (!ranchStats[userId]) ranchStats[userId] = { eggs: 0, milk: 0 };
  ranchStats[userId][action] += amount;

  res.status(200).send("OK");
});

// ---- Start server ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
