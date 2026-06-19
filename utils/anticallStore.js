import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');
const ANTICALL_FILE = path.join(DATA_DIR, 'anticall.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let anticallStates = new Map();

export function loadAnticallStates() {
  try {
    if (fs.existsSync(ANTICALL_FILE)) {
      const data = JSON.parse(fs.readFileSync(ANTICALL_FILE, 'utf8'));
      anticallStates = new Map(Object.entries(data));
      console.log(`✅ Loaded ${anticallStates.size} anti-call settings from storage`);
    } else {
      console.log('📝 No existing anti-call settings found, starting fresh');
    }
  } catch (error) {
    console.error('❌ Error loading anti-call states:', error.message);
  }
}

function saveAnticallStates() {
  try {
    const data = Object.fromEntries(anticallStates);
    fs.writeFileSync(ANTICALL_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Saved ${anticallStates.size} anti-call settings to storage`);
  } catch (error) {
    console.error('❌ Error saving anti-call states:', error.message);
  }
}

export function getAnticallState(chatId) {
  if (!chatId) return true;
  const state = anticallStates.get(chatId);
  return state !== undefined ? state : true;
}

export function setAnticallState(chatId, enabled) {
  if (!chatId) return false;
  anticallStates.set(chatId, enabled);
  saveAnticallStates();
  return enabled;
}
