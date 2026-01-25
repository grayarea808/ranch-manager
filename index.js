const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Discord bot ID
const GUILD_ID = process.env.GUILD_ID;   // Your server ID

if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error('Missing BOT_TOKEN, CLIENT_ID, or GUILD_ID');
    process.exit(1);
}

// === Discord Bot Setup ===
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// In-memory stats
const stats = {}; // { playerId: { eggs: 0, milk: 0 } }

// === Slash Commands Setup ===
const commands = [
    {
        name: 'ranchstats',
        description: 'Show total ranch stats for a player',
        options: [
            {
                name: 'player',
                type: 6, // USER
                description: 'The player to check',
                required: false
            }
        ]
    },
    {
        name: 'today',
        description: 'Show today\'s ranch actions'
    },
    {
        name: 'leaderboard',
        description: 'Show leaderboard for ranch contributions'
    }
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (error) {
        console.error(error);
    }
})();

// === Discord Events ===
client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'ranchstats') {
        const user = options.getUser('player') || interaction.user;
        const playerStats = stats[user.id] || { eggs: 0, milk: 0 };
        const embed = new EmbedBuilder()
            .setTitle(`${user.username}'s Ranch Stats`)
            .addFields(
                { name: 'Eggs', value: playerStats.eggs.toString(), inline: true },
                { name: 'Milk', value: playerStats.milk.toString(), inline: true }
            )
            .setColor(0x00FF00);
        await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'today') {
        let description = '';
        for (const id in stats) {
            const s = stats[id];
            description += `<@${id}> - Eggs: ${s.eggs}, Milk: ${s.milk}\n`;
        }
        const embed = new EmbedBuilder()
            .setTitle(`Today's Ranch Stats`)
            .setDescription(description || 'No stats yet')
            .setColor(0xFFD700);
        await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'leaderboard') {
        const sorted = Object.entries(stats)
            .sort(([, a], [, b]) => (b.eggs + b.milk) - (a.eggs + a.milk));
        let description = '';
        sorted.forEach(([id, s], i) => {
            description += `#${i + 1} <@${id}> - Eggs: ${s.eggs}, Milk: ${s.milk}\n`;
        });
        const embed = new EmbedBuilder()
            .setTitle('Ranch Leaderboard')
            .setDescription(description || 'No stats yet')
            .setColor(0xFF4500);
        await interaction.reply({ embeds: [embed] });
    }
});

// === Express Webhook Server ===
const app = express();
app.use(bodyParser.json());

app.post('/ranch-webhook', (req, res) => {
    const data = req.body;

    if (!data.embeds || !data.embeds[0]) return res.sendStatus(400);

    const embed = data.embeds[0];
    const title = embed.title; // "Eggs Added", "Milk Added"
    const desc = embed.description; // parse player, amount

    const match = desc.match(/<@(\d+)> .* (\d+)$/m);
    if (!match) return res.sendStatus(400);

    const playerId = match[1];
    const amount = parseInt(match[2]);

    if (!stats[playerId]) stats[playerId] = { eggs: 0, milk: 0 };

    if (title.includes('Eggs')) stats[playerId].eggs += amount;
    if (title.includes('Milk')) stats[playerId].milk += amount;

    console.log(`Updated stats for ${playerId}:`, stats[playerId]);

    res.sendStatus(200);
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));

client.login(BOT_TOKEN);
