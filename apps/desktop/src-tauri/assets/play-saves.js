// Stands in for the browser database (IndexedDB) that Godot's web build keeps user:// in, because
// Play here's sandboxed frame has none. Godot reaches it only through Emscripten's IDBFS: a database
// per mount point (/userfs) holding one object store ("FILE_DATA") of {timestamp, mode, contents}
// entries keyed by path, with a "timestamp" index. Only what IDBFS uses is here. Every finished
// write is passed to onCommit, which sends it to Game Studio to keep on disk.
// Pasted into play-shell.html when it is served; tested in src/views/play/play-saves.test.ts.
function gamestudioSaveStore(initial, onCommit) {
  const files = new Map();
  const asDate = (t) => new Date(t instanceof Date ? t.getTime() : Number(t));
  const clone = (e) => ({ timestamp: asDate(e.timestamp), mode: e.mode, ...(e.contents ? { contents: new Uint8Array(e.contents) } : {}) });
  for (const e of initial || []) files.set(String(e.path), clone(e));
  const later = (fn) => setTimeout(fn, 0);

  function Request(tx) {
    this.result = undefined;
    this.error = null;
    this.readyState = "pending";
    this.transaction = tx;
    this.source = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  const succeed = (req, result) => {
    req.result = result;
    req.readyState = "done";
    if (req.onsuccess) req.onsuccess({ type: "success", target: req, preventDefault() {} });
  };

  // A transaction completes once its requests (and any they start) have run.
  function Transaction(mode) {
    this.mode = mode;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._done = false;
    this._puts = [];
    this._deletes = [];
    later(() => this._settle());
  }
  Transaction.prototype._run = function (fn) {
    this._pending++;
    later(() => {
      try {
        fn();
      } finally {
        this._pending--;
        this._settle();
      }
    });
  };
  Transaction.prototype._settle = function () {
    if (this._pending || this._done) return;
    later(() => {
      if (this._pending || this._done) return;
      this._done = true;
      if (this._puts.length || this._deletes.length) onCommit({ puts: this._puts, deletes: this._deletes });
      if (this.oncomplete) this.oncomplete({ type: "complete", target: this });
    });
  };
  Transaction.prototype.objectStore = function () {
    return new Store(this);
  };
  Transaction.prototype.abort = function () {};

  function Store(tx) {
    this.name = "FILE_DATA";
    this.transaction = tx;
    this.indexNames = { contains: (n) => n === "timestamp", length: 1 };
  }
  Store.prototype.createIndex = function () {};
  Store.prototype.index = function () {
    const tx = this.transaction;
    return {
      openKeyCursor() {
        const req = new Request(tx);
        const keys = [...files.keys()];
        let i = 0;
        const step = () =>
          tx._run(() => {
            while (i < keys.length && !files.has(keys[i])) i++;
            if (i >= keys.length) return succeed(req, null);
            const key = keys[i++];
            succeed(req, { primaryKey: key, key: asDate(files.get(key).timestamp), continue: step });
          });
        step();
        return req;
      },
    };
  };
  Store.prototype.get = function (path) {
    const req = new Request(this.transaction);
    this.transaction._run(() => {
      const e = files.get(String(path));
      succeed(req, e ? clone(e) : undefined);
    });
    return req;
  };
  Store.prototype.put = function (entry, path) {
    const tx = this.transaction;
    if (tx.mode !== "readwrite") throw new Error("ReadOnlyError: put in a read-only transaction");
    const key = String(path);
    const value = clone(entry); // copied now, like IndexedDB: the caller may reuse its buffer
    const req = new Request(tx);
    tx._run(() => {
      files.set(key, value);
      tx._puts.push({ path: key, timestamp: value.timestamp.getTime(), mode: value.mode, ...(value.contents ? { contents: new Uint8Array(value.contents) } : {}) });
      succeed(req, key);
    });
    return req;
  };
  Store.prototype.delete = function (path) {
    const tx = this.transaction;
    if (tx.mode !== "readwrite") throw new Error("ReadOnlyError: delete in a read-only transaction");
    const key = String(path);
    const req = new Request(tx);
    tx._run(() => {
      files.delete(key);
      tx._deletes.push(key);
      succeed(req, undefined);
    });
    return req;
  };

  function Database(name) {
    this.name = name;
    this.version = 21;
    this.objectStoreNames = { contains: (n) => n === "FILE_DATA", length: 1 };
  }
  Database.prototype.transaction = function (_stores, mode) {
    return new Transaction(mode === "readwrite" ? "readwrite" : "readonly");
  };
  Database.prototype.createObjectStore = function () {
    return new Store(new Transaction("versionchange"));
  };
  Database.prototype.close = function () {};

  return {
    open(name) {
      const req = new Request(null);
      req.onupgradeneeded = null;
      req.onblocked = null;
      later(() => succeed(req, new Database(String(name))));
      return req;
    },
    cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  };
}
