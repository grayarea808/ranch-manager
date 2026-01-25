app.post("/ranch-webhook", (req, res) => {
    const data = req.body;

    let userId, action, amount, playerName;

    // Case 1: Syn County webhook (usually inside embeds)
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

    // Case 2: Manual JSON POST {userId, action, amount, playerName}
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

    // Here you would update your database or in-memory stats
    if (!ranchStats[userId]) ranchStats[userId] = { eggs: 0, milk: 0 };
    ranchStats[userId][action] += amount;

    res.status(200).send("OK");
});
