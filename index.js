import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import pg from "pg";

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const GUILD_ID = process.env.GUILD_ID;

const RANCH_INPUT_CHANNEL_ID = process.env.RANCH_INPUT_CHANNEL_ID;
const RANCH_OUTPUT_CHANNEL_ID = process.env.RANCH_OUTPUT_CHANNEL_ID;

const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 2000);
const POLL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

const BACKFILL_ON_START = String(process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 300);

const RANCH_NAME = process.env.RANCH_NAME || "Beaver Falls Ranch";
const CAMP_NAME = process.env.CAMP_NAME || "Beaver Falls Camp";

// prices
const RANCH_MILK_PRICE = Number(process.env.RANCH_MILK_PRICE || 1.25);
const RANCH_EGG_PRICE = Number(process.env.RANCH_EGG_PRICE || 1.25);

// camp points weights
const CAMP_MATERIALS_PTS = Number(process.env.CAMP_MATERIALS_PTS || 2);
const CAMP_DELIVERY_PTS = Number(process.env.CAMP_DELIVERY_PTS || 3);
const CAMP_SUPPLIES_PTS = Number(process.env.CAMP_SUPPLIES_PTS || 1);
const CAMP_FEE_RATE = Number(process.env.CAMP_FEE_RATE || 0.30); // 30%

// delivery values (you can tweak)
const CAMP_DELIVERY_SMALL = Number(process.env.CAMP_DELIVERY_SMALL || 500);
const CAMP_DELIVERY_MED = Number(process.env.CAMP_DELIVERY_MED || 950);
const CAMP_DELIVERY_LARGE = Number(process.env.CAMP_DELIVERY_LARGE || 1500);

const PAGE_SIZE = Number(process.env.PAGE_SIZE || 7);

function must(name) {
  if (!process.env[name]) throw new Error(`❌ Missing Railway variable: ${name}`);
}
["DISCORD_TOKEN", "DATABASE_URL", "GUILD_ID", "RANCH_INPUT_CHANNEL_ID", "RANCH_OUTPUT_CHANNEL_ID", "CAMP_INPUT_CHANNEL_ID", "CAMP_OUTPUT_CHANNEL_ID"].forEach(must);

// =====================
// APP + DB + DISCORD
// =====================
const app = express();
app.use(express.json());

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // IMPORTANT for name resolving
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// =====================
// DB
// =====================
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranch_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS camp_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // unique per message+kind so a single discord message can insert milk+eggs both
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename='ranch_events' AND indexname='ranch_events_source_message_id_kind_uq'
      ) THEN
        CREATE UNIQUE INDEX ranch_events_source_message_id_kind_uq
          ON ranch_events(source_message_id, kind)
          WHERE source_message_id IS NOT NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename='camp_events' AND indexname='camp_events_source_message_id_kind_uq'
      ) THEN
        CREATE UNIQUE INDEX camp_events_source_message_id_kind_uq
          ON camp_events(source_message_id, kind)
          WHERE source_message_id IS NOT NULL;
      END IF;
    END $$;
  `);
}

async function getState(key) {
  const { rows } = await pool.query(`SELECT value FROM bot_state WHERE key=$1`, [key]);
  return rows[0]?.value ?? null;
}
async function setState(key, value) {
  await pool.query(
    `
    INSERT INTO bot_state(key,value) VALUES($1,$2)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `,
    [key, String(value)]
  );
}

// =====================
// NAME RESOLVING (THIS IS THE FIX)
// =====================
const nameCache = new Map(); // userId -> name
async function resolveDisplayName(userId) {
  if (!userId) return "unknown-user";
  if (nameCache.has(userId)) return nameCache.get(userId);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    // Try member fetch first (gives nickname / server display)
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      const name = member.displayName || member.user?.globalName || member.user?.username || `user-${String(userId).slice(-4)}`;
      nameCache.set(userId, name);
      return name;
    }

    // fallback: user fetch
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
      const name = user.globalName || user.username || `user-${String(userId).slice(-4)}`;
      nameCache.set(userId, name);
      return name;
    }
  } catch {}

  const fallback = `user-${String(userId).slice(-4)}`;
  nameCache.set(userId, fallback);
  return fallback;
}

// =====================
// PARSERS
// =====================
function parseUserIdFromContent(content) {
  const m1 = content.match(/<@(\d{15,20})>/);
  if (m1) return m1[1];

  const m2 = content.match(/Discord:\s*@.*?(\d{15,20})/i);
  if (m2) return m2[1];

  const m3 = content.match(/@\S[\s\S]{0,80}?(\d{15,20})/);
  if (m3) return m3[1];

  const m4 = content.match(/\b(\d{15,20})\b/);
  if (m4) return m4[1];

  return null;
}

function parseRanchMessage(content) {
  const userId = parseUserIdFromContent(content);
  if (!userId) return [];

  const events = [];

  const milkMatch = content.match(/Added\s+Milk\s+to\s+ranch\s+id\s+\d+\s*:\s*(\d+)/i);
  if (milkMatch) events.push({ user_id: userId, kind: "milk", qty: Number(milkMatch[1]), amount: 0 });

  const eggsMatch = content.match(/Added\s+Eggs\s+to\s+ranch\s+id\s+\d+\s*:\s*(\d+)/i);
  if (eggsMatch) events.push({ user_id: userId, kind: "eggs", qty: Number(eggsMatch[1]), amount: 0 });

  return events;
}

// Camp examples you showed:
// "Delivered Supplies: 42"
// "Donated ... / Materials added: 1.0"
// "Made a Sale Of 100 Of Stock For $1600"
function parseCampMessage(content) {
  const userId = parseUserIdFromContent(content);
  if (!userId) return [];

  const events = [];

  const supplies = content.match(/Delivered\s+Supplies:\s*(\d+)/i);
  if (supplies) events.push({ user_id: userId, kind: "supplies", qty: Number(supplies[1]), amount: 0 });

  const mats = content.match(/Materials\s+added:\s*([\d.]+)/i);
  if (mats) events.push({ user_id: userId, kind: "materials", qty: Number(mats[1]), amount: 0 });

  const stockSale = content.match(/Made a Sale Of\s+(\d+)\s+Of\s+Stock\s+For\s+\$([\d.]+)/i);
  if (stockSale) {
    const value = Number(stockSale[2]);
    events.push({ user_id: userId, kind: "delivery_value", qty: 1, amount: value });
  }

  return events;
}

async function insertEvent(table, messageId, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO ${table}(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id, kind) DO NOTHING
    `,
    [String(messageId), String(evt.user_id), evt.kind, evt.qty, evt.amount, createdAtIso || new Date().toISOString()]
  );
}

// =====================
// DISCORD HELPERS
// =====================
async function fetchChannel(channelId) {
  const ch = await client.channels.fetch(channelId);
  if (!ch) throw new Error(`Channel not found: ${channelId}`);
  return ch;
}

async function ensureSingleMessage(channelId, stateKey, initialPayload) {
  const ch = await fetchChannel(channelId);
  let msgId = await getState(stateKey);

  if (msgId) {
    try {
      return await ch.messages.fetch(msgId);
    } catch {}
  }

  const msg = await ch.send(initialPayload);
  await setState(stateKey, msg.id);
  return msg;
}

// =====================
// FORMATTING
// =====================
function money(n) {
  return `$${Number(n).toFixed(2)}`;
}
function etNow() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
}
function fmtNextPayoutLabel(prefix) {
  const now = new Date();
  const d = new Date(now);
  const day = d.getDay();
  const diff = (6 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  const label = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
  return `${prefix}: ${label}`;
}

// =====================
// TOTALS
// =====================
async function ranchTotals() {
  const { rows } = await pool.query(`
    SELECT
      user_id,
      SUM(CASE WHEN kind='milk' THEN qty ELSE 0 END) AS milk,
      SUM(CASE WHEN kind='eggs' THEN qty ELSE 0 END) AS eggs
    FROM ranch_events
    GROUP BY user_id
  `);

  const users = rows.map((r) => {
    const milk = Number(r.milk || 0);
    const eggs = Number(r.eggs || 0);
    const milkPay = milk * RANCH_MILK_PRICE;
    const eggsPay = eggs * RANCH_EGG_PRICE;
    const total = milkPay + eggsPay;
    return { user_id: r.user_id, milk, eggs, milkPay, eggsPay, total };
  });

  users.sort((a, b) => b.total - a.total);
  return users;
}

async function campTotals() {
  const { rows } = await pool.query(`
    SELECT
      user_id,
      SUM(CASE WHEN kind='materials' THEN qty ELSE 0 END) AS materials,
      SUM(CASE WHEN kind='supplies' THEN qty ELSE 0 END) AS supplies,
      SUM(CASE WHEN kind='delivery_value' THEN amount ELSE 0 END) AS delivery_value,
      SUM(CASE WHEN kind='delivery_value' THEN qty ELSE 0 END) AS deliveries
    FROM camp_events
    GROUP BY user_id
  `);

  // Player payout pool is 70% of delivery_value (30% camp fee)
  const totalDeliveryValue = rows.reduce((a, r) => a + Number(r.delivery_value || 0), 0);
  const payoutPool = totalDeliveryValue * (1 - CAMP_FEE_RATE);

  const users = rows.map((r) => {
    const materials = Number(r.materials || 0);
    const supplies = Number(r.supplies || 0);
    const deliveries = Number(r.deliveries || 0);

    const points =
      materials * CAMP_MATERIALS_PTS +
      deliveries * CAMP_DELIVERY_PTS +
      supplies * CAMP_SUPPLIES_PTS;

    return { user_id: r.user_id, materials, supplies, deliveries, points };
  });

  const totalPoints = users.reduce((a, u) => a + u.points, 0);

  const withPayouts = users.map((u) => {
    const payout = totalPoints > 0 ? (u.points / totalPoints) * payoutPool : 0;
    return { ...u, payout };
  });

  withPayouts.sort((a, b) => b.payout - a.payout);

  return {
    users: withPayouts,
    totalDeliveryValue,
    campRevenue: totalDeliveryValue * CAMP_FEE_RATE,
    totalPoints,
  };
}

// =====================
// EMBEDS (NAMES NOT IDS)
// =====================
async function makeRanchEmbed({ users, page, totalPages }) {
  const start = page * PAGE_SIZE;
  const slice = users.slice(start, start + PAGE_SIZE);

  const totalMilk = users.reduce((a, u) => a + u.milk, 0);
  const totalEggs = users.reduce((a, u) => a + u.eggs, 0);
  const totalPayout = users.reduce((a, u) => a + u.total, 0);

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${RANCH_NAME} — Page ${page + 1}/${Math.max(totalPages, 1)}`)
    .setDescription(`📅 ${fmtNextPayoutLabel("Next Ranch Payout")}`);

  embed.addFields(
    { name: "💰 Ranch Payout", value: `**${money(totalPayout)}**`, inline: true },
    { name: "🥛", value: `**${totalMilk.toLocaleString()}**`, inline: true },
    { name: "🥚", value: `**${totalEggs.toLocaleString()}**`, inline: true }
  );

  for (const u of slice) {
    const displayName = await resolveDisplayName(u.user_id);

    const value = [
      `🥛 Milk: ${u.milk} -> ${money(u.milkPay)}`,
      `🥚 Eggs: ${u.eggs} -> ${money(u.eggsPay)}`,
      `💰 **Total: ${money(u.total)}**`,
    ].join("\n");

    embed.addFields({
      name: displayName, // ✅ NAME not <@id>
      value,
      inline: true,
    });
  }

  embed.setFooter({ text: `Total Ranch Profit: ${money(0)} • Today at ${etNow()}` });
  return embed;
}

async function makeCampEmbed({ users, page, totalPages, totalDeliveryValue, campRevenue, totalPoints }) {
  const start = page * PAGE_SIZE;
  const slice = users.slice(start, start + PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle(`🏕️ ${CAMP_NAME} — Page ${page + 1}/${Math.max(totalPages, 1)}`)
    .setDescription(
      `📅 ${fmtNextPayoutLabel("Next Camp Payout")}\n` +
      `Payout Mode: Points (${Math.round(CAMP_FEE_RATE * 100)}% camp fee)`
    );

  // top row similar “columns”
  embed.addFields(
    { name: "🧾 Total Delivery Value", value: `**${money(totalDeliveryValue)}**`, inline: true },
    { name: "🪙 Camp Revenue", value: `**${money(campRevenue)}**`, inline: true },
    { name: "⭐ Total Points", value: `**${Math.round(totalPoints).toLocaleString()}**`, inline: true }
  );

  for (const u of slice) {
    const displayName = await resolveDisplayName(u.user_id);

    const value = [
      `🪨 Materials: ${u.materials.toFixed(2)}`,
      `🚚 Deliveries: ${u.deliveries}`,
      `📦 Supplies: ${u.supplies}`,
      `⭐ Points: ${Math.round(u.points)}`,
      `💰 **Payout: ${money(u.payout)}**`,
    ].join("\n");

    embed.addFields({
      name: displayName, // ✅ NAME not <@id>
      value,
      inline: true,
    });
  }

  embed.setFooter({ text: `Today at ${etNow()}` });
  return embed;
}

function makePagerRow(prefix, page, totalPages) {
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}_prev`)
      .setLabel("◀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId(`${prefix}_next`)
      .setLabel("▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextDisabled)
  );
}

// =====================
// RENDER / UPDATE
// =====================
let editTimer = null;

async function renderAllBoards() {
  // ranch
  const ranchUsers = await ranchTotals();
  const ranchTotalPages = Math.max(1, Math.ceil(ranchUsers.length / PAGE_SIZE));
  let ranchPage = Number((await getState("ranch_page")) || 0);
  if (Number.isNaN(ranchPage) || ranchPage < 0) ranchPage = 0;
  if (ranchPage > ranchTotalPages - 1) ranchPage = ranchTotalPages - 1;
  await setState("ranch_page", ranchPage);

  const ranchMsg = await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", {
    embeds: [new EmbedBuilder().setTitle("Loading…")],
    components: [],
  });

  const ranchEmbed = await makeRanchEmbed({ users: ranchUsers, page: ranchPage, totalPages: ranchTotalPages });
  await ranchMsg.edit({ embeds: [ranchEmbed], components: [makePagerRow("ranch", ranchPage, ranchTotalPages)] });

  // camp
  const camp = await campTotals();
  const campUsers = camp.users;
  const campTotalPages = Math.max(1, Math.ceil(campUsers.length / PAGE_SIZE));
  let campPage = Number((await getState("camp_page")) || 0);
  if (Number.isNaN(campPage) || campPage < 0) campPage = 0;
  if (campPage > campTotalPages - 1) campPage = campTotalPages - 1;
  await setState("camp_page", campPage);

  const campMsg = await ensureSingleMessage(CAMP_OUTPUT_CHANNEL_ID, "camp_board_msg", {
    embeds: [new EmbedBuilder().setTitle("Loading…")],
    components: [],
  });

  const campEmbed = await makeCampEmbed({
    users: campUsers,
    page: campPage,
    totalPages: campTotalPages,
    totalDeliveryValue: camp.totalDeliveryValue,
    campRevenue: camp.campRevenue,
    totalPoints: camp.totalPoints,
  });

  await campMsg.edit({ embeds: [campEmbed], components: [makePagerRow("camp", campPage, campTotalPages)] });
}

function scheduleUpdate() {
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    try {
      await renderAllBoards();
    } catch (e) {
      console.error("❌ renderAllBoards error:", e?.message || e);
    }
  }, LEADERBOARD_DEBOUNCE_MS);
}

// =====================
// BUTTON INTERACTIONS
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const id = interaction.customId;
  if (!["ranch_prev", "ranch_next", "camp_prev", "camp_next"].includes(id)) return;

  try {
    await interaction.deferUpdate();

    if (id.startsWith("ranch")) {
      const ranchUsers = await ranchTotals();
      const totalPages = Math.max(1, Math.ceil(ranchUsers.length / PAGE_SIZE));
      let page = Number((await getState("ranch_page")) || 0);
      if (id === "ranch_prev") page = Math.max(0, page - 1);
      if (id === "ranch_next") page = Math.min(totalPages - 1, page + 1);
      await setState("ranch_page", page);

      const msg = await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", {
        embeds: [new EmbedBuilder().setTitle("Loading…")],
        components: [],
      });
      const embed = await makeRanchEmbed({ users: ranchUsers, page, totalPages });
      await msg.edit({ embeds: [embed], components: [makePagerRow("ranch", page, totalPages)] });
      return;
    }

    if (id.startsWith("camp")) {
      const camp = await campTotals();
      const users = camp.users;
      const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
      let page = Number((await getState("camp_page")) || 0);
      if (id === "camp_prev") page = Math.max(0, page - 1);
      if (id === "camp_next") page = Math.min(totalPages - 1, page + 1);
      await setState("camp_page", page);

      const msg = await ensureSingleMessage(CAMP_OUTPUT_CHANNEL_ID, "camp_board_msg", {
        embeds: [new EmbedBuilder().setTitle("Loading…")],
        components: [],
      });
      const embed = await makeCampEmbed({
        users,
        page,
        totalPages,
        totalDeliveryValue: camp.totalDeliveryValue,
        campRevenue: camp.campRevenue,
        totalPoints: camp.totalPoints,
      });
      await msg.edit({ embeds: [embed], components: [makePagerRow("camp", page, totalPages)] });
      return;
    }
  } catch (e) {
    console.error("❌ button error:", e?.message || e);
  }
});

// =====================
// POLL + BACKFILL
// =====================
async function pollChannelOnce(channelId, parser, tableName, label) {
  const channel = await fetchChannel(channelId);
  const msgs = await channel.messages.fetch({ limit: 50 });

  let inserted = 0;

  for (const [, m] of msgs) {
    const content = (m.content || "").trim();
    if (!content) continue;

    const events = parser(content);
    if (!events.length) continue;

    for (const evt of events) {
      try {
        await insertEvent(tableName, m.id, evt, m.createdAt?.toISOString());
        inserted++;
      } catch {}
    }
  }

  console.log(`${label} poll fetched=${msgs.size} inserted~=${inserted}`);
}

async function backfillChannel(channelId, parser, tableName, maxMessages, label) {
  const channel = await fetchChannel(channelId);
  let lastId = null;
  let scanned = 0;
  let inserted = 0;

  while (scanned < maxMessages) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (!batch.size) break;

    for (const [, m] of batch) {
      scanned++;
      lastId = m.id;

      const content = (m.content || "").trim();
      if (!content) continue;

      const events = parser(content);
      if (!events.length) continue;

      for (const evt of events) {
        try {
          await insertEvent(tableName, m.id, evt, m.createdAt?.toISOString());
          inserted++;
        } catch {}
      }

      if (scanned >= maxMessages) break;
    }
  }

  console.log(`📥 ${label} backfill scanned=${scanned} inserted~=${inserted}`);
}

// =====================
// STARTUP
// =====================
client.once("clientReady", async () => {
  try {
    console.log(`🤖 Online as ${client.user.tag}`);
    await ensureTables();

    if (!(await getState("ranch_page"))) await setState("ranch_page", 0);
    if (!(await getState("camp_page"))) await setState("camp_page", 0);

    await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", {
      embeds: [new EmbedBuilder().setTitle("Loading…")],
      components: [],
    });
    await ensureSingleMessage(CAMP_OUTPUT_CHANNEL_ID, "camp_board_msg", {
      embeds: [new EmbedBuilder().setTitle("Loading…")],
      components: [],
    });

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling ranch + camp (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillChannel(RANCH_INPUT_CHANNEL_ID, parseRanchMessage, "ranch_events", BACKFILL_MAX_MESSAGES, "RANCH");
      await backfillChannel(CAMP_INPUT_CHANNEL_ID, parseCampMessage, "camp_events", BACKFILL_MAX_MESSAGES, "CAMP");
    }

    await renderAllBoards();

    setInterval(async () => {
      try {
        await pollChannelOnce(RANCH_INPUT_CHANNEL_ID, parseRanchMessage, "ranch_events", "RANCH");
        await pollChannelOnce(CAMP_INPUT_CHANNEL_ID, parseCampMessage, "camp_events", "CAMP");
        scheduleUpdate();
      } catch (e) {
        console.error("❌ poll loop error:", e?.message || e);
      }
    }, POLL_EVERY_MS);

    console.log("✅ Running.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🚀 Web listening on ${PORT}`));
