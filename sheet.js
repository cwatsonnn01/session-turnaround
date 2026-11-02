'use strict';

// Thin wrapper around the tracker Google Sheet. All flag logic lives in the
// sheet's formulas; this file only reads values and writes dates.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const { SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, MOCK_DATA, NODE_ENV, TIMEZONE = 'America/Toronto' } = process.env;
const mockMode = !!MOCK_DATA && NODE_ENV !== 'production';
const MOCK_FILE = path.join(__dirname, 'mock.json');

// Formula columns are filled down to this row. A new session needs an empty row above it.
const LAST_FORMULA_ROW = 300;

let sheetsApi;
function api() {
  if (sheetsApi) return sheetsApi;
  const text = GOOGLE_SERVICE_ACCOUNT_JSON.trim();
  const creds = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsApi = google.sheets({ version: 'v4', auth });
  return sheetsApi;
}

// Short cache so a page refresh from several producers at once is one read.
let cache = { at: 0, data: null };

async function readAll() {
  if (mockMode) return JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8'));
  if (cache.data && Date.now() - cache.at < 5000) return cache.data;
  const res = await api().spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: [`Sessions!A1:AD${LAST_FORMULA_ROW}`, 'Clients!A1:D500', 'Settings!A1:C10', 'Studios!A1:B50', 'Team!A1:D50', 'Holidays!A1:A200'],
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const [sessions, clients, settings, studios, team, holidays] = res.data.valueRanges.map((r) => r.values || []);
  const data = {
    headers: sessions[0] || [],
    rows: sessions.slice(1),
    clients: clients.slice(1),
    settings: settings.slice(1),
    studios: studios.slice(1),
    team: team.slice(1),
    holidays: holidays.slice(1).map((r) => r[0]).filter(Boolean),
    asOf: todayLabel(),
  };
  cache = { at: Date.now(), data };
  return data;
}

function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Text typed by people is written with USER_ENTERED (so dates parse), which would
// also run anything that looks like a formula. A leading apostrophe keeps it text.
function safe(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v;
}

// writes: { 'Header name': value }. Headers are looked up by name so columns can move.
async function writeCells(headers, row, writes) {
  const data = Object.entries(writes).map(([name, value]) => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`Column "${name}" not found on the Sessions tab`);
    return { range: `Sessions!${colLetter(i)}${row}`, values: [[safe(value)]] };
  });
  if (mockMode) {
    const file = JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8'));
    const r = file.rows[row - 2] || (file.rows[row - 2] = []);
    for (const [name, value] of Object.entries(writes)) r[headers.indexOf(name)] = value;
    fs.writeFileSync(MOCK_FILE, JSON.stringify(file, null, 2));
    return;
  }
  await api().spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  cache = { at: 0, data: null };
}

async function appendSession(raw, client, studio, producer, session, updatedBy, recorded) {
  const iClient = raw.headers.indexOf('Client');
  let idx = raw.rows.findIndex((r) => !r[iClient]);
  if (idx < 0) idx = raw.rows.length;
  const row = idx + 2;
  if (row > LAST_FORMULA_ROW) {
    const err = new Error('Sheet full');
    err.userMessage = `The Sessions tab is full at row ${LAST_FORMULA_ROW}. Copy the formulas further down in the sheet first.`;
    throw err;
  }
  const writes = { Client: client, Studio: studio, Producer: producer, Session: session, 'Last updated by': updatedBy };
  if (recorded) writes.Recorded = recorded;
  await writeCells(raw.headers, row, writes);
  return row;
}

// Recording dates can be today or up to `maxBack` days earlier, never in the future.
function checkRecordedDate(text, maxBack = 14) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return 'Pick the date the session was recorded.';
  const today = todayISO();
  const t = Date.parse(`${text}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (isNaN(t)) return 'Pick the date the session was recorded.';
  if (t > now) return 'The recording date can\'t be in the future.';
  if (now - t > maxBack * 864e5) return `That's more than ${maxBack} days ago. Ask Ops to enter it in the sheet.`;
  return null;
}

function todayISO() {
  // en-CA formats as YYYY-MM-DD, which Sheets reads as a date.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function todayLabel() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
}

// Clients tab: Client | Studio | Contacts | Approver email. Written as RAW so nothing is parsed.
const CLIENTS_MAX_ROW = 200; // Sessions' client dropdown reads Clients!A2:A200
async function appendClient(raw, values) {
  let idx = raw.clients.findIndex((r) => !(r[0] || '').trim());
  if (idx < 0) idx = raw.clients.length;
  const row = idx + 2;
  if (row > CLIENTS_MAX_ROW) {
    const err = new Error('Clients tab full');
    err.userMessage = `The Clients tab is full at row ${CLIENTS_MAX_ROW}. Extend the client dropdown range in the sheet first.`;
    throw err;
  }
  if (mockMode) {
    const file = JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8'));
    file.clients[idx] = values;
    fs.writeFileSync(MOCK_FILE, JSON.stringify(file, null, 1));
    return row;
  }
  await api().spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Clients!A${row}:D${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
  cache = { at: 0, data: null };
  return row;
}

module.exports = { readAll, writeCells, appendSession, appendClient, todayISO, checkRecordedDate, LAST_FORMULA_ROW };
