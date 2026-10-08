const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = process.env.ADMIN_PIN || 'CHANGE-ME';
const sessions = new Map();
const rate = new Map();
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');
const PUBLIC_DIR = __dirname;
const SLOT_MINUTES = 60;
const OPEN_MINUTES = 16 * 60;
const CLOSE_MINUTES = 20 * 60 + 30;
const TABLES = Array.from({ length: 8 }, (_, i) => ({ id: `T${i + 1}`, name: `Table ${i + 1}`, capacity: 2 }));
const TIMES = [16 * 60, 17 * 60, 18 * 60, 19 * 60, 20 * 60].filter(m => m + SLOT_MINUTES <= CLOSE_MINUTES);

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readBookings() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function writeBookings(bookings) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bookings, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function isFriday(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return !Number.isNaN(d.getTime()) && d.getDay() === 5;
}
function validDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && isFriday(dateStr);
}
function validTime(time) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || '');
  if (!m) return false;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return TIMES.includes(mins);
}
function nextFridays(count = 12) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let delta = (5 - today.getDay() + 7) % 7;
  if (delta === 0 && now.getHours() >= 20 && now.getMinutes() >= 30) delta = 7;
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + delta + i * 7);
    return d.toISOString().slice(0, 10);
  });
}
function makeCode() { return 'DW-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function sanitizeBooking(b) {
  return { id: b.id, code: b.code, date: b.date, time: b.time, tableId: b.tableId, tableName: b.tableName, name: b.name, players: b.players, createdAt: b.createdAt };
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function limited(req, key, max = 40, windowMs = 60_000) {
  const now = Date.now(), k = clientIp(req) + ':' + key;
  const arr = (rate.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); rate.set(k, arr); return arr.length > max;
}
function newSession() { return crypto.randomBytes(32).toString('hex'); }
function adminOK(req) { const token = req.headers['x-admin-token']; return typeof token === 'string' && sessions.has(token) && sessions.get(token) > Date.now(); }
function cleanupSessions() { const now = Date.now(); for (const [k,v] of sessions) if (v < now) sessions.delete(k); }


async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  cleanupSessions();
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    if (limited(req, 'admin-login', 8, 15 * 60_000)) return json(res, 429, { error: 'Too many login attempts. Try again later.' });
    let data; try { data = await body(req); } catch { return json(res, 400, { error: 'Invalid request.' }); }
    if (typeof data.pin !== 'string' || data.pin !== ADMIN_PIN) return json(res, 401, { error: 'Invalid staff PIN.' });
    const token = newSession(); sessions.set(token, Date.now() + 8 * 60 * 60_000);
    return json(res, 200, { token });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') { const token=req.headers['x-admin-token']; if (token) sessions.delete(token); return json(res,200,{ok:true}); }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { company: 'Dicewars', day: 'Friday', open: '16:00', close: '20:30', slotMinutes: SLOT_MINUTES, tables: TABLES, times: TIMES.map(m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`), dates: nextFridays() });
  }
  if (req.method === 'GET' && url.pathname === '/api/availability') {
    if (limited(req, 'availability', 120)) return json(res, 429, { error: 'Too many requests.' });
    const date = url.searchParams.get('date');
    if (!validDate(date)) return json(res, 400, { error: 'Choose a Friday.' });
    const bookings = readBookings().filter(b => b.date === date);
    return json(res, 200, { date, bookings: bookings.map(b => ({ time: b.time, tableId: b.tableId })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/bookings') {
    if (limited(req, 'booking', 12, 10 * 60_000)) return json(res, 429, { error: 'Too many booking attempts. Please wait and try again.' });
    let data; try { data = await body(req); } catch { return json(res, 400, { error: 'Invalid request.' }); }
    const { date, time, tableId, name, email, phone = '', players } = data;
    if (!validDate(date)) return json(res, 400, { error: 'Bookings are Friday only.' });
    if (!validTime(time)) return json(res, 400, { error: 'That time is unavailable.' });
    const table = TABLES.find(t => t.id === tableId);
    if (!table) return json(res, 400, { error: 'That table does not exist.' });
    const playerCount = Number(players);
    if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > table.capacity) return json(res, 400, { error: 'Each table seats up to 2 players.' });
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) return json(res, 400, { error: 'Please enter your name.' });
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Please enter a valid email.' });
    const bookings = readBookings();
    const clash = bookings.find(b => b.date === date && b.time === time && b.tableId === tableId);
    if (clash) return json(res, 409, { error: 'Sorry, that table has just been booked. Please choose another.' });
    const booking = { id: crypto.randomUUID(), code: makeCode(), date, time, tableId, tableName: table.name, name: name.trim(), email: email.trim(), phone: String(phone).trim().slice(0, 40), players: playerCount, createdAt: new Date().toISOString() };
    bookings.push(booking); writeBookings(bookings);
    return json(res, 201, { booking: sanitizeBooking(booking) });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/bookings') {
    if (!adminOK(req)) return json(res, 401, { error: 'Invalid staff PIN.' });
    const date = url.searchParams.get('date');
    let bookings = readBookings();
    if (date) bookings = bookings.filter(b => b.date === date);
    bookings.sort((a, b) => `${a.date} ${a.time} ${a.tableId}`.localeCompare(`${b.date} ${b.time} ${b.tableId}`));
    return json(res, 200, { bookings });
  }
  if (req.method === 'GET' && url.pathname === '/api/bookings/lookup') {
    if (limited(req, 'lookup', 20, 10 * 60_000)) return json(res, 429, { error: 'Too many requests.' });
    const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!/^DW-[A-F0-9]{8}$/.test(code) || !email) return json(res, 400, { error: 'Enter your booking reference and email.' });
    const b = readBookings().find(x => x.code === code && x.email.toLowerCase() === email);
    if (!b) return json(res, 404, { error: 'Booking not found.' });
    return json(res, 200, { booking: sanitizeBooking(b) });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/bookings/')) {
    if (limited(req, 'cancel', 10, 10 * 60_000)) return json(res, 429, { error: 'Too many cancellation attempts.' });
    const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const bookings = readBookings(); const b = bookings.find(x => x.code === code && x.email.toLowerCase() === email);
    if (!b) return json(res, 404, { error: 'Booking not found.' });
    writeBookings(bookings.filter(x => x.id !== b.id)); return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/bookings/')) {
    if (!adminOK(req)) return json(res, 401, { error: 'Invalid staff PIN.' });
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const bookings = readBookings();
    const next = bookings.filter(b => b.id !== id);
    if (next.length === bookings.length) return json(res, 404, { error: 'Booking not found.' });
    writeBookings(next); return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^([.][.][\\/])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return json(res, 404, { error: 'Not found.' });
  const ext = path.extname(full).toLowerCase();
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(full).pipe(res);
}

http.createServer((req, res) => handle(req, res).catch(err => { console.error(err); json(res, 500, { error: 'Server error.' }); })).listen(PORT, () => console.log(`Dicewars running on http://localhost:${PORT}`));
