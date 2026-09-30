'use strict';
const fs = require('fs');
const path = require('path');
const model = require('./model');

/** JSON document on disk (atomic writes) with change listeners. */
class Store {
  constructor(file) {
    this.file = file;
    this.listeners = [];
    this.data = this.read();
  }

  read() {
    try {
      return model.defaults(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      if (fs.existsSync(this.file)) {
        // Keep an unreadable file for recovery instead of overwriting it.
        fs.renameSync(this.file, this.file + '.corrupt-' + Date.now());
      }
      return model.defaults({});
    }
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /** Applies fn(data), saves, notifies listeners and returns fn's result. */
  edit(fn) {
    const result = fn(this.data);
    this.write();
    for (const l of this.listeners) l(this.data);
    return result;
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}

module.exports = Store;
