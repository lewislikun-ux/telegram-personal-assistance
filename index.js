require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const agentRegistry = require('./modules/agent-registry');
const askAgent = require('./agents/ask');
const newsAgent = require('./agents/news');
const gmAgent = require('./agents/gm');
const driveAgent = require('./agents/drive');
const trafficAgent = require('./agents/traffic');
const cryptoAgent = require('./agents/crypto');
const fxAgent = require('./agents/fx');
const proactiveAgents = require('./agents/proactive');

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PORT = 10000,
} = process.env;

const required = ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '20mb' }));
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function nowIso() { return new Date().toISOString(); }
function sgNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' })); }
function todayDateString() {
  const d = sgNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function currency(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `$${x.toFixed(2)}` : '-';
}
function num(x, dp = 2) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(dp) : '-';
}
function addDays(dateString, days) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addYears(dateString, count) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  d.setFullYear(d.getFullYear() + count);
  return d.toISOString().slice(0, 10);
}
function getDayType(dateString) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  return [0, 6].includes(d.getDay()) ? 'weekend' : 'weekday';
}
function telegramMessageIso(msg) {
  const unix = Number(msg?.date || 0);
  return unix ? new Date(unix * 1000).toISOString() : nowIso();
}
function durationHoursBetween(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const hours = (end - start) / 3600000;
  return hours > 0 ? hours : null;
}
function formatDurationHours(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '-';
  const totalMinutes = Math.round(h * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (wholeHours <= 0) return `${mins}m`;
  if (mins === 0) return `${wholeHours}h`;
  return `${wholeHours}h ${mins}m`;
}

const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🧠 Ask', callback_data: 'show:askhelp' },
      { text: '☀️ GM', callback_data: 'show:gm' },
    ],
    [
      { text: '📰 News', callback_data: 'show:news:top' },
      { text: '🚗 Drive?', callback_data: 'show:shoulddrive' },
    ],
    [
      { text: '📈 PHV Today', callback_data: 'show:phvtoday' },
      { text: '📊 PHV Week', callback_data: 'show:phvweek' },
    ],
    [
      { text: '🚕 Traffic', callback_data: 'show:traffic' },
      { text: '💱 FX', callback_data: 'show:fx' },
    ],
    [
      { text: '₿ Crypto', callback_data: 'show:crypto' },
      { text: '▶️ Start PHV', callback_data: 'show:phvstart' },
    ],
    [
      { text: '⏸ Mid PHV', callback_data: 'show:phvnow' },
      { text: '🏁 End PHV', callback_data: 'show:phvend' },
    ],
  ],
};

async function send(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}
async function editOrSend(chatId, messageId, text, extra = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (_) {
    return send(chatId, text, extra);
  }
}

async function ensureUser(msg) {
  const row = {
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    username: msg.from.username || null,
    first_name: msg.from.first_name || null,
    last_name: msg.from.last_name || null,
    updated_at: nowIso(),
  };
  const { error } = await supabase.from('users').upsert(row, { onConflict: 'telegram_user_id' });
  if (error) throw error;
}

function phvComputed(log) {
  const gross = Number(log.gross_amount || 0);
  const petrol = Number(log.petrol_cost || 0);
  const hours = Number(log.hours_worked || 0);
  const net = gross - petrol;
  return {
    gross, petrol, hours, net,
    hourlyGross: hours > 0 ? gross / hours : 0,
    hourlyNet: hours > 0 ? net / hours : 0,
  };
}
function summarizePhv(logs) {
  const total = logs.reduce((acc, row) => {
    const c = phvComputed(row);
    acc.count += 1;
    acc.gross += c.gross;
    acc.petrol += c.petrol;
    acc.hours += c.hours;
    acc.net += c.net;
    acc.km += Number(row.km_driven || 0);
    return acc;
  }, { count: 0, gross: 0, petrol: 0, hours: 0, net: 0, km: 0 });
  total.hourlyGross = total.hours > 0 ? total.gross / total.hours : 0;
  total.hourlyNet = total.hours > 0 ? total.net / total.hours : 0;
  return total;
}
function summarizeComparableSessions(logs, dayType, excludeDate = null) {
  const filtered = logs.filter((row) => getDayType(row.log_date) === dayType && row.log_date !== excludeDate);
  return summarizePhv(filtered);
}

async function getPhvRange(userId, startDate, endDate) {
  const { data, error } = await supabase
    .from('phv_logs')
    .select('*')
    .eq('telegram_user_id', userId)
    .gte('log_date', startDate)
    .lte('log_date', endDate)
    .order('log_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
async function getActiveSession(userId) {
  const { data, error } = await supabase.from('phv_active_session').select('*').eq('telegram_user_id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

function parsePhvLog(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  const result = {};
  for (const part of parts) {
    const m = part.match(/^(date|gross|hours|km|petrol|trip|trips|notes?)\s*[:=]?\s*(.+)$/i);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  const date = result.date || todayDateString();
  const gross = parseFloat(result.gross || '');
  const hours = parseFloat(result.hours || '');
  const km = parseFloat(result.km || '');
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : 0;
  const tripCount = result.trip !== undefined ? parseInt(result.trip, 10) : (result.trips !== undefined ? parseInt(result.trips, 10) : null);
  const notes = result.note || result.notes || null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(gross) || !Number.isFinite(hours)) return null;
  return {
    log_date: date,
    gross_amount: gross,
    hours_worked: hours,
    km_driven: Number.isFinite(km) ? km : null,
    petrol_cost: Number.isFinite(petrol) ? petrol : 0,
    trip_count: Number.isInteger(tripCount) ? tripCount : null,
    notes,
  };
}
function parsePhvNowBody(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  const result = {};
  for (const part of parts) {
    const m = part.match(/^(gross|hours|current|mileage|petrol)\s*[:=]?\s*(.+)$/i);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  const gross = parseFloat(result.gross || '');
  const hours = result.hours !== undefined ? parseFloat(result.hours || '') : null;
  const currentMileage = parseFloat(result.current || result.mileage || '');
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : 0;
  if (!Number.isFinite(gross) || !Number.isFinite(currentMileage)) return null;
  return {
    gross_amount: gross,
    hours_worked: Number.isFinite(hours) ? hours : null,
    current_mileage: currentMileage,
    petrol_cost: Number.isFinite(petrol) ? petrol : 0,
  };
}
function parsePhvEnd(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0].match(/^\d+(?:\.\d+)?$/) ? parseFloat(parts[0]) : null;
  const result = {};
  for (const part of parts) {
    const m = part.match(/^(end|gross|hours|petrol|date|notes?)\s*[:=]?\s*(.+)$/i);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  const endMileage = first ?? parseFloat(result.end || '');
  const gross = parseFloat(result.gross || '');
  const hours = result.hours !== undefined ? parseFloat(result.hours || '') : null;
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : 0;
  const date = result.date || todayDateString();
  const notes = result.note || result.notes || null;
  if (!Number.isFinite(endMileage) || !Number.isFinite(gross)) return null;
  return {
    end_mileage: endMileage,
    gross_amount: gross,
    hours_worked: Number.isFinite(hours) ? hours : null,
    petrol_cost: Number.isFinite(petrol) ? petrol : 0,
    log_date: date,
    notes,
  };
}

function makeAgentContext(msg) {
  return {
    msg,
    bot,
    supabase,
    send,
    editOrSend,
    ensureUser,
    escapeHtml,
    currency,
    num,
    addDays,
    addYears,
    todayDateString,
    getDayType,
    summarizeComparableSessions,
    getPhvRange,
    MAIN_KEYBOARD,
  };
}

agentRegistry.register('ask', askAgent);
agentRegistry.register('news', newsAgent);
agentRegistry.register('gm', gmAgent);
agentRegistry.register('drive', driveAgent);
agentRegistry.register('traffic', trafficAgent);
agentRegistry.register('crypto', cryptoAgent);
agentRegistry.register('fx', fxAgent);

async function handleStart(msg) {
  await ensureUser(msg);
  return send(msg.chat.id, [
    `<b>Hi ${escapeHtml(msg.from.first_name || 'there')}</b>`,
    '',
    'This build matches your current repo structure with <code>agents/</code> and <code>modules/</code>.',
    '',
    '<b>Main commands</b>',
    '<code>/ask your question</code>',
    '<code>/gm</code>',
    '<code>/news</code>',
    '<code>/shoulddrive</code>',
    '<code>/traffic</code>',
    '<code>/fx</code>',
    '<code>/crypto</code>',
    '',
    '<b>PHV commands</b>',
    '<code>/phvlog date:2026-03-30 | gross:145 | hours:2.5 | km:68 | petrol:18</code>',
    '<code>/phvstart 112280</code>',
    '<code>/phvnow gross:62 | current:112314</code>',
    '<code>/phvend 112348 | gross:145</code>',
    '<code>/phvtoday</code>',
    '<code>/phvweek</code>',
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function showHelp(chatId) {
  return send(chatId, [
    '<b>Commands</b>',
    '',
    '<code>/ask your question</code> — AI only used here',
    '<code>/gm</code> — good morning briefing',
    '<code>/news [top|singapore|business|world]</code>',
    '<code>/shoulddrive</code>',
    '<code>/traffic</code>',
    '<code>/fx</code>',
    '<code>/crypto</code>',
    '',
    '<b>PHV</b>',
    '<code>/phvlog date:YYYY-MM-DD | gross:145 | hours:2.5 | km:68 | petrol:18</code>',
    '<code>/phvstart 112280</code>',
    '<code>/phvnow gross:62 | current:112314</code>',
    '<code>/phvend 112348 | gross:145</code>',
    '<code>/phvtoday</code>',
    '<code>/phvweek</code>',
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handleAgent(name, msg, body = '', editContext = null) {
  await ensureUser(msg);
  return agentRegistry.invoke(name, makeAgentContext(msg), body, editContext);
}

async function handlePhvLog(msg, body) {
  await ensureUser(msg);
  const parsed = parsePhvLog(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/phvlog date:2026-03-30 | gross:145 | hours:2.5 | km:68 | petrol:18</code>');
  const payload = {
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    ...parsed,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { error } = await supabase.from('phv_logs').insert(payload);
  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not save PHV log. Check your Supabase table columns.');
  }
  const c = phvComputed(payload);
  return send(msg.chat.id, [
    '<b>PHV log saved</b>',
    `Date: <b>${escapeHtml(parsed.log_date)}</b>`,
    `Gross: <b>${currency(c.gross)}</b>`,
    `Petrol: <b>${currency(c.petrol)}</b>`,
    `Net: <b>${currency(c.net)}</b>`,
    `Hours: <b>${num(c.hours)}</b>`,
    `Hourly net: <b>${currency(c.hourlyNet)}</b>`,
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handlePhvStart(msg, body) {
  await ensureUser(msg);
  const active = await getActiveSession(msg.from.id);
  if (active) return send(msg.chat.id, `You already have an active PHV session.\nStart mileage: <b>${num(active.start_mileage, 0)}</b>`);
  const mileage = parseFloat(String(body || '').trim());
  if (!Number.isFinite(mileage)) return send(msg.chat.id, 'Use: <code>/phvstart 112280</code>');
  const { error } = await supabase.from('phv_active_session').upsert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    start_mileage: mileage,
    started_at: telegramMessageIso(msg),
    updated_at: nowIso(),
  }, { onConflict: 'telegram_user_id' });
  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not start PHV session.');
  }
  return send(msg.chat.id, [
    '<b>PHV session started</b>',
    `Start mileage: <b>${num(mileage, 0)}</b>`,
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handlePhvNow(msg, body) {
  await ensureUser(msg);
  const active = await getActiveSession(msg.from.id);
  if (!active) return send(msg.chat.id, 'No active PHV session found. Use <code>/phvstart starting_mileage</code> first.');
  const parsed = parsePhvNowBody(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/phvnow gross:62 | current:112314</code>');
  const km = parsed.current_mileage - Number(active.start_mileage || 0);
  if (!(km >= 0)) return send(msg.chat.id, 'Current mileage cannot be lower than start mileage.');
  const currentAt = telegramMessageIso(msg);
  const effectiveHours = Number.isFinite(parsed.hours_worked) ? parsed.hours_worked : durationHoursBetween(active.started_at, currentAt);
  if (!Number.isFinite(effectiveHours) || effectiveHours <= 0) return send(msg.chat.id, 'Could not determine hours worked yet.');
  const pseudo = {
    gross_amount: parsed.gross_amount,
    petrol_cost: parsed.petrol_cost || 0,
    hours_worked: effectiveHours,
  };
  const c = phvComputed(pseudo);
  return send(msg.chat.id, [
    '<b>PHV mid-session</b>',
    `KM so far: <b>${num(km)}</b>`,
    `Gross so far: <b>${currency(parsed.gross_amount)}</b>`,
    `Petrol est.: <b>${currency(parsed.petrol_cost || 0)}</b>`,
    `Net so far: <b>${currency(c.net)}</b>`,
    `Hours so far: <b>${num(effectiveHours)}</b> (${escapeHtml(formatDurationHours(effectiveHours))})`,
    `Hourly net so far: <b>${currency(c.hourlyNet)}</b>`,
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handlePhvEnd(msg, body) {
  await ensureUser(msg);
  const active = await getActiveSession(msg.from.id);
  if (!active) return send(msg.chat.id, 'No active PHV session found. Use <code>/phvstart starting_mileage</code> first.');
  const parsed = parsePhvEnd(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/phvend 112348 | gross:145</code>');
  const km = parsed.end_mileage - Number(active.start_mileage || 0);
  if (!(km >= 0)) return send(msg.chat.id, 'End mileage cannot be lower than start mileage.');
  const endedAt = telegramMessageIso(msg);
  const effectiveHours = Number.isFinite(parsed.hours_worked) ? parsed.hours_worked : durationHoursBetween(active.started_at, endedAt);
  if (!Number.isFinite(effectiveHours) || effectiveHours <= 0) return send(msg.chat.id, 'Could not determine hours worked yet.');
  const payload = {
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    log_date: parsed.log_date,
    gross_amount: parsed.gross_amount,
    hours_worked: effectiveHours,
    km_driven: km,
    petrol_cost: parsed.petrol_cost || 0,
    start_mileage: Number(active.start_mileage),
    end_mileage: parsed.end_mileage,
    notes: parsed.notes,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { error: insertErr } = await supabase.from('phv_logs').insert(payload);
  if (insertErr) {
    console.error(insertErr);
    return send(msg.chat.id, 'Could not save PHV end log.');
  }
  await supabase.from('phv_active_session').delete().eq('telegram_user_id', msg.from.id);
  const c = phvComputed(payload);
  return send(msg.chat.id, [
    '<b>PHV session ended</b>',
    `Start mileage: <b>${num(active.start_mileage, 0)}</b>`,
    `End mileage: <b>${num(parsed.end_mileage, 0)}</b>`,
    `Session KM: <b>${num(km)}</b>`,
    `Gross: <b>${currency(payload.gross_amount)}</b>`,
    `Petrol: <b>${currency(payload.petrol_cost)}</b>`,
    `Net: <b>${currency(c.net)}</b>`,
    `Hours: <b>${num(payload.hours_worked)}</b>`,
    `Hourly net: <b>${currency(c.hourlyNet)}</b>`,
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handlePhvToday(msg, editContext = null) {
  await ensureUser(msg);
  const logs = await getPhvRange(msg.from.id, todayDateString(), todayDateString());
  if (!logs.length) {
    const text = 'No PHV logs for today yet.';
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
  }
  const s = summarizePhv(logs);
  const text = [
    '<b>PHV today</b>',
    `Entries: <b>${s.count}</b>`,
    `Gross: <b>${currency(s.gross)}</b>`,
    `Petrol: <b>${currency(s.petrol)}</b>`,
    `Net: <b>${currency(s.net)}</b>`,
    `Hours: <b>${num(s.hours)}</b>`,
    `Hourly net: <b>${currency(s.hourlyNet)}</b>`,
  ].join('\n');
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

async function handlePhvWeek(msg, editContext = null) {
  await ensureUser(msg);
  const end = todayDateString();
  const start = addDays(end, -6);
  const logs = await getPhvRange(msg.from.id, start, end);
  if (!logs.length) {
    const text = 'No PHV logs in the past 7 days yet.';
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
  }
  const s = summarizePhv(logs);
  const weekday = summarizePhv(logs.filter((x) => getDayType(x.log_date) === 'weekday'));
  const weekend = summarizePhv(logs.filter((x) => getDayType(x.log_date) === 'weekend'));
  const text = [
    '<b>PHV past 7 days</b>',
    `Range: <b>${escapeHtml(start)}</b> to <b>${escapeHtml(end)}</b>`,
    `Entries: <b>${s.count}</b>`,
    `Gross: <b>${currency(s.gross)}</b>`,
    `Petrol: <b>${currency(s.petrol)}</b>`,
    `Net: <b>${currency(s.net)}</b>`,
    `Hours: <b>${num(s.hours)}</b>`,
    `Avg hourly net: <b>${currency(s.hourlyNet)}</b>`,
    '',
    '<b>Weekday vs weekend</b>',
    `• Weekday avg hourly net: <b>${currency(weekday.hourlyNet)}</b> from <b>${weekday.count}</b> log(s)`,
    `• Weekend avg hourly net: <b>${currency(weekend.hourlyNet)}</b> from <b>${weekend.count}</b> log(s)`,
  ].join('\n');
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

function parseNaturalLanguage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (/^good morning$/i.test(trimmed)) return { command: '/gm', body: '' };
  if (/^news(?:\s+(top|singapore|business|world))?$/i.test(trimmed)) {
    const m = trimmed.match(/^news(?:\s+(top|singapore|business|world))?$/i);
    return { command: '/news', body: m?.[1] || 'top' };
  }
  if (/^should i drive\??$/i.test(trimmed)) return { command: '/shoulddrive', body: '' };
  return null;
}

async function routeMessage(msg) {
  if (!msg?.text) return;
  const rawText = String(msg.text || '').trim();
  if (!rawText) return;

  const parsed = rawText.startsWith('/')
    ? (() => {
        const [command, ...rest] = rawText.split(' ');
        return { command: command.toLowerCase(), body: rest.join(' ').trim() };
      })()
    : parseNaturalLanguage(rawText);

  if (!parsed) return send(msg.chat.id, 'Unknown command. Use <code>/help</code>.', { reply_markup: MAIN_KEYBOARD });

  const { command, body } = parsed;
  switch (command) {
    case '/start': return handleStart(msg);
    case '/help': return showHelp(msg.chat.id);
    case '/ask': return handleAgent('ask', msg, body);
    case '/gm': return handleAgent('gm', msg, body);
    case '/news': return handleAgent('news', msg, body || 'top');
    case '/shoulddrive': return handleAgent('drive', msg, body);
    case '/traffic': return handleAgent('traffic', msg, body);
    case '/crypto': return handleAgent('crypto', msg, body);
    case '/fx': return handleAgent('fx', msg, body);
    case '/phvlog': return handlePhvLog(msg, body);
    case '/phvstart': return handlePhvStart(msg, body);
    case '/phvnow': return handlePhvNow(msg, body);
    case '/phvend': return handlePhvEnd(msg, body);
    case '/phvtoday': return handlePhvToday(msg);
    case '/phvweek': return handlePhvWeek(msg);
    default: return send(msg.chat.id, 'Unknown command. Use <code>/help</code>.', { reply_markup: MAIN_KEYBOARD });
  }
}

async function routeCallback(query) {
  const data = String(query?.data || '');
  const msg = query?.message;
  if (!msg || !data) return;
  const fauxMsg = {
    chat: msg.chat,
    from: query.from,
    date: msg.date,
    text: '',
  };

  try {
    if (data === 'show:askhelp') return send(msg.chat.id, 'Use <code>/ask your question</code>', { reply_markup: MAIN_KEYBOARD });
    if (data === 'show:gm') return handleAgent('gm', fauxMsg);
    if (data === 'show:shoulddrive') return handleAgent('drive', fauxMsg, '', { messageId: msg.message_id });
    if (data === 'show:traffic') return handleAgent('traffic', fauxMsg);
    if (data === 'show:fx') return handleAgent('fx', fauxMsg);
    if (data === 'show:crypto') return handleAgent('crypto', fauxMsg);
    if (data === 'show:phvstart') return send(msg.chat.id, 'Use <code>/phvstart 112280</code>', { reply_markup: MAIN_KEYBOARD });
    if (data === 'show:phvnow') return send(msg.chat.id, 'Use <code>/phvnow gross:62 | current:112314</code>', { reply_markup: MAIN_KEYBOARD });
    if (data === 'show:phvend') return send(msg.chat.id, 'Use <code>/phvend 112348 | gross:145</code>', { reply_markup: MAIN_KEYBOARD });
    if (data === 'show:phvtoday') return handlePhvToday(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:phvweek') return handlePhvWeek(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:news') return handleAgent('news', fauxMsg, 'top', { messageId: msg.message_id });
    if (data.startsWith('show:news:')) return handleAgent('news', fauxMsg, data.split(':')[2], { messageId: msg.message_id });
  } finally {
    try { await bot.answerCallbackQuery(query.id); } catch (_) {}
  }
}

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'telegram-personal-assistance', date: nowIso() });
});

app.post('/telegram-webhook', async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.sendStatus(500);
  }
});

bot.on('message', async (msg) => {
  try {
    await routeMessage(msg);
  } catch (err) {
    console.error('Message route failed:', err);
    await send(msg.chat.id, 'Something went wrong. Check Render logs.');
  }
});

bot.on('callback_query', async (query) => {
  try {
    await routeCallback(query);
  } catch (err) {
    console.error('Callback route failed:', err);
    try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch (_) {}
  }
});

proactiveAgents.start({
  supabase,
  registry: agentRegistry,
  makeContext,
});

const server = app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  try {
    const webhook = `${WEBHOOK_URL.replace(/\/$/, '')}/telegram-webhook`;
    await bot.setWebHook(webhook);
    console.log('Webhook set to', webhook);
  } catch (err) {
    console.error('Failed to set webhook:', err.message);
  }
});

function makeContext(msg) {
  return makeAgentContext(msg);
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
