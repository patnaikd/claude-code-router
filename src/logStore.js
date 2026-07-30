import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class LogStore extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.stream = null;
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.stream = createWriteStream(this.filePath, { flags: 'a' });
  }

  append(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    this.stream.write(line);
    this.emit('entry', entry);
  }

  async list({ limit = 100 } = {}) {
    const entries = [];

    try {
      const lines = createInterface({
        input: createReadStream(this.filePath),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          entries.push(JSON.parse(line));
        } catch {
          // Ignore corrupted partial lines; future writes remain valid JSONL.
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return entries.slice(-limit).reverse();
  }
}
