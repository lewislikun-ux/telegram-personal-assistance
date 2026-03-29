require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN);

// =========================
// 🔌 AGENT IMPORTS (FIXED)
// =========================

const askAgent = require('./agents/ask');
const newsAgent = require('./agents/news');
const gmAgent = require('./agents/gm');
const driveAgent = require('./agents/drive');
const trafficAgent = require('./agents/traffic');
const cryptoAgent = require('./agents/crypto');
const fxAgent = require('./agents/fx');

// =========================
// 🎛 MAIN DASHBOARD (CLEAN UI)
// =========================

const MAIN_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🤖 Ask AI', callback_data: 'ask' },
        { text: '🌅 GM', callback_data: 'gm' },
      ],
      [
        { text: '📰 News', callback_data: 'news' },
        { text: '🚦 Traffic', callback_data: 'traffic' },
      ],
      [
        { text: '💱 FX', callback_data: 'fx' },
        { text: '🪙 Crypto', callback_data: 'crypto' },
      ],
      [
        { text: '📅 Due', callback_data: 'due' },
        { text: '🗓 Weekly', callback_data: 'weekly' },
      ],
      [
        { text: '🚗 Start Session', callback_data: 'phv_start' },
        { text: '🏁 End Session', callback_data: 'phv_end' },
      ],
      [
        { text: '📈 PHV Week', callback_data: 'phv_week' },
        { text: '❓ Should Drive', callback_data: 'shoulddrive' },
      ],
      [
        { text: '⛽ PHV Settings', callback_data: 'phv_settings' },
        { text: '🛠 Maintenance', callback_data: 'maintenance' },
      ],
      [
        { text: '➕ Note', callback_data: 'note' },
        { text: '✅ Task', callback_data: 'task' },
      ],
    ],
  },
};

function showMenu(chatId) {
  bot.sendMessage(chatId, '🚀 <b>Main Dashboard</b>', {
    parse_mode: 'HTML',
    ...MAIN_KEYBOARD,
  });
}

// =========================
// 📘 HELP (FULL)
// =========================

function showHelp(chatId) {
  bot.sendMessage(
    chatId,
    `
<b>📘 Commands</b>

<b>🤖 AI</b>
/ask your question

<b>🌅 Daily</b>
/gm - Good Morning briefing

<b>📰 Info</b>
/news
/traffic
/fx
/crypto

<b>🚗 PHV</b>
/startphv
/endphv
/phvweek
/shoulddrive

<b>📊 Others</b>
/due
/weekly

<b>🛠 Utility</b>
/note
/task
`,
    { parse_mode: 'HTML' }
  );
}

// =========================
// 📨 COMMAND HANDLER (FIXED)
// =========================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/start')) return showMenu(chatId);
  if (text.startsWith('/help')) return showHelp(chatId);

  if (text.startsWith('/ask')) return askAgent(bot, msg);
  if (text.startsWith('/gm')) return gmAgent(bot, msg);
  if (text.startsWith('/news')) return newsAgent(bot, msg);
  if (text.startsWith('/traffic')) return trafficAgent(bot, msg);
  if (text.startsWith('/fx')) return fxAgent(bot, msg);
  if (text.startsWith('/crypto')) return cryptoAgent(bot, msg);
  if (text.startsWith('/shoulddrive')) return driveAgent(bot, msg);
});

// =========================
// 🔘 BUTTON HANDLER (FIXED)
// =========================

bot.on('callback_query', async (query) => {
  const msg = query.message;
  const chatId = msg.chat.id;
  const data = query.data;

  switch (data) {
    case 'ask':
      return bot.sendMessage(chatId, 'Use /ask your question');

    case 'gm':
      return gmAgent(bot, msg);

    case 'news':
      return newsAgent(bot, msg);

    case 'traffic':
      return trafficAgent(bot, msg);

    case 'fx':
      return fxAgent(bot, msg);

    case 'crypto':
      return cryptoAgent(bot, msg);

    case 'shoulddrive':
      return driveAgent(bot, msg);

    default:
      bot.sendMessage(chatId, 'Feature coming soon');
  }

  bot.answerCallbackQuery(query.id);
});

// =========================
// 🌐 SERVER (UNCHANGED)
// =========================

app.post(`/webhook/${process.env.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Bot running');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('Server running');
});
