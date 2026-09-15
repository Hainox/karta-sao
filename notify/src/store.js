import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function writeAtomic(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
}

export function createStore({ dir, journalLimit = 500 }) {
  const journalPath = path.join(dir, 'journal.jsonl');
  const pendingPath = path.join(dir, 'pending.json');

  const readPendingFile = async () => {
    try {
      const parsed = JSON.parse(await readFile(pendingPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };

  const writePendingFile = (entries) => writeAtomic(pendingPath, `${JSON.stringify(entries, null, 2)}\n`);

  return {
    async init() {
      await mkdir(dir, { recursive: true });
    },

    async appendJournal(entry) {
      const record = { id: entry.id || randomUUID(), at: new Date().toISOString(), ...entry };
      await appendFile(journalPath, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    },

    async readJournal(limit = journalLimit) {
      try {
        const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean);
        return lines.slice(-limit).map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },

    async listPending() {
      const now = Date.now();
      return (await readPendingFile()).filter((entry) => entry.status === 'open' && (!entry.expiresAt || Date.parse(entry.expiresAt) > now));
    },

    async getPending(id) {
      return (await readPendingFile()).find((entry) => entry.id === id) || null;
    },

    async addPending(entry) {
      const record = { id: entry.id || randomUUID(), status: 'open', createdAt: new Date().toISOString(), ...entry };
      const entries = await readPendingFile();
      entries.push(record);
      await writePendingFile(entries);
      return record;
    },

    async updatePending(id, patch) {
      const entries = await readPendingFile();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      entries[index] = { ...entries[index], ...patch };
      await writePendingFile(entries);
      return entries[index];
    },

    async closePending(id, resolution) {
      const entries = await readPendingFile();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const closed = {
        ...entries[index],
        status: resolution.status || 'closed',
        resolution,
        closedAt: new Date().toISOString()
      };
      entries[index] = closed;
      await writePendingFile(entries);
      return closed;
    }
  };
}
