/*
 * AppPanrom runtime: interprets the validated IR (see docs/language.md) and renders it.
 * One file, no dependencies. The same file runs in the Studio preview iframe and inside
 * the generated Android app's WebView, so preview and APK share behaviour.
 *
 *   AppPanrom.createRuntime(ir, host)  -> headless runtime (interpreter + view tree; works in Node)
 *   AppPanrom.mount(ir, rootEl, host)  -> DOM renderer on top of a runtime
 *
 * host (all optional): { log(level, text), toast(text), message(text, done), storage, namespace }
 * User code is never turned into JavaScript: the IR is walked by the interpreter below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AppPanrom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.1.0';
  var LIMITS = {
    steps: 1000000, // interpreter steps per entry point (init / event / render)
    depth: 100, // user-function call depth
    listItems: 100000,
    stringLength: 1000000,
    logLength: 2000,
    storageValue: 100000, // chars per stored value
    storageTotal: 1000000, // chars per app
    keyLength: 100,
  };

  // ------------------------------------------------------------------ errors / values
  function ApError(message, pos, fatal) {
    this.message = message;
    this.pos = pos || null;
    this.fatal = !!fatal; // fatal errors (limits) cannot be caught by try/catch
    this.isApError = true;
  }
  ApError.prototype = Object.create(Error.prototype);
  ApError.prototype.name = 'ApError';

  function newDict() { return Object.create(null); }
  function isDict(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'list';
    var t = typeof v;
    if (t === 'number') return 'number';
    if (t === 'string') return 'text';
    if (t === 'boolean') return 'bool';
    return 'dict';
  }
  function truthy(v) {
    if (v === null || v === false || v === 0 || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (isDict(v)) return Object.keys(v).length > 0;
    return true;
  }
  function toText(v, depth) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (depth > 8) return '...';
    if (Array.isArray(v)) return '[' + v.map(function (x) { return typeof x === 'string' ? JSON.stringify(x) : toText(x, depth + 1); }).join(', ') + ']';
    var keys = Object.keys(v);
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ': ' + (typeof v[k] === 'string' ? JSON.stringify(v[k]) : toText(v[k], depth + 1)); }).join(', ') + '}';
  }
  function deepEqual(a, b, depth) {
    depth = depth || 0;
    if (a === b) return true;
    if (depth > 20 || typeOf(a) !== typeOf(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false;
      return true;
    }
    if (isDict(a)) {
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) if (!(ka[j] in b) || !deepEqual(a[ka[j]], b[ka[j]], depth + 1)) return false;
      return true;
    }
    return false;
  }
  function fromJson(v, depth) {
    if (depth > 50) throw new ApError('JSON is nested too deeply.');
    if (Array.isArray(v)) return v.map(function (x) { return fromJson(x, (depth || 0) + 1); });
    if (v !== null && typeof v === 'object') {
      var d = newDict();
      Object.keys(v).forEach(function (k) { d[k] = fromJson(v[k], (depth || 0) + 1); });
      return d;
    }
    return v;
  }
  function checkNum(v, what) {
    if (typeof v !== 'number' || !isFinite(v)) throw new ApError(what + ' must be a number, not ' + typeOf(v) + '.');
    return v;
  }
  function need(fn, i, v, type) {
    var ok = {
      str: typeof v === 'string', num: typeof v === 'number' && isFinite(v), bool: typeof v === 'boolean',
      list: Array.isArray(v), dict: isDict(v), any: true,
    }[type];
    if (!ok) {
      var names = { str: 'text', num: 'a number', bool: 'true/false', list: 'a list', dict: 'a dictionary' };
      throw new ApError(fn + ' argument ' + (i + 1) + ' must be ' + names[type] + ', not ' + typeOf(v) + '.');
    }
    return v;
  }

  // ------------------------------------------------------------------ styles
  var HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var SIZE = /^(\d{1,3}%|fill)$/;
  /** Validates a style dict against ir.style_schema; returns {valid, problems}. */
  function validateStyle(raw, schema) {
    var valid = {}, problems = [];
    Object.keys(raw).forEach(function (k) {
      var d = schema[k], v = raw[k], ok = false;
      if (!d) { problems.push("unknown style '" + k + "'"); return; }
      if (d.type === 'color') ok = typeof v === 'string' && HEX.test(v);
      else if (d.type === 'number') ok = typeof v === 'number' && isFinite(v) && v >= d.min && v <= d.max;
      else if (d.type === 'size') ok = (typeof v === 'number' && v >= 0 && v <= 2000) || (typeof v === 'string' && SIZE.test(v));
      else if (d.type === 'enum') ok = typeof v === 'string' && d.values.indexOf(v) >= 0;
      else if (d.type === 'bool') ok = typeof v === 'boolean';
      if (ok) valid[k] = v; else problems.push("invalid value for style '" + k + "'");
    });
    return { valid: valid, problems: problems };
  }

  // ------------------------------------------------------------------ components (runtime side)
  var INPUT_KIND = {
    input_uruvakku: 'text', password_input: 'password', number_input: 'number',
    checkbox_uruvakku: 'checkbox', toggle_uruvakku: 'toggle', dropdown_uruvakku: 'dropdown',
  };
  var COMPONENT_NAMES = [
    'title', 'text_kaattu', 'button', 'input_uruvakku', 'password_input', 'number_input', 'checkbox_uruvakku',
    'toggle_uruvakku', 'dropdown_uruvakku', 'image_kaattu', 'list_kaattu', 'progress_kaattu', 'loading_kaattu',
    'divider_kaattu', 'card_uruvakku', 'column_uruvakku', 'row_uruvakku', 'center_ama',
  ];
  function defaultInput(kind) {
    return kind === 'checkbox' || kind === 'toggle' ? false : kind === 'number' ? null : '';
  }
  function coerceInput(kind, v, fn) {
    if (kind === 'checkbox' || kind === 'toggle') return need(fn, 1, v, 'bool');
    if (kind === 'number') return v === null ? null : need(fn, 1, v, 'num');
    return need(fn, 1, v, 'str');
  }
  /** Static scan: input name -> {kind, initial} so input_value works before/without rendering. */
  function scanInputs(ir) {
    var found = newDict();
    function lit(n) {
      if (!n) return undefined;
      if (n.t === 'str' || n.t === 'num' || n.t === 'bool') return n.v;
      return undefined;
    }
    function visit(list) {
      (list || []).forEach(function (n) {
        if (!n || typeof n !== 'object') return;
        if (n.t === 'comp' && INPUT_KIND[n.c] && n.props.name && n.props.name.t === 'str' && !(n.props.name.v in found)) {
          var kind = INPUT_KIND[n.c], init = lit(n.props.initial);
          if (init === undefined && kind === 'dropdown' && n.props.options && n.props.options.t === 'list' && n.props.options.items[0]) init = lit(n.props.options.items[0]);
          found[n.props.name.v] = { kind: kind, initial: init === undefined ? defaultInput(kind) : init };
        }
        if (n.children) visit(n.children);
        if (n.body) visit(n.body);
        if (n.branches) n.branches.forEach(function (b) { visit(b.body); });
        if (n.else) visit(n.else);
        if (n.handler) visit(n.handler);
      });
    }
    Object.keys(ir.screens).forEach(function (s) { visit(ir.screens[s].body); });
    return found;
  }

  // ------------------------------------------------------------------ storage
  function memoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      keys: function () { return Object.keys(m); },
    };
  }
  function webStorage() {
    try {
      var s = window.localStorage, probe = '__ap_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return {
        getItem: function (k) { return s.getItem(k); },
        setItem: function (k, v) { s.setItem(k, v); },
        removeItem: function (k) { s.removeItem(k); },
        keys: function () { var o = []; for (var i = 0; i < s.length; i++) o.push(s.key(i)); return o; },
      };
    } catch (e) { return memoryStorage(); }
  }

  /** Browser/WebView implementations of device features. Both degrade to a console warning where unsupported. */
  function defaultDevice(log) {
    return {
      clipboard: function (text) {
        var nav = typeof navigator !== 'undefined' ? navigator : null;
        if (nav && nav.clipboard && nav.clipboard.writeText) {
          nav.clipboard.writeText(text).catch(function () { log('warning', 'clipboard_copy: the clipboard is not available here (permission denied or blocked by the preview).'); });
        } else log('warning', 'clipboard_copy: the clipboard is not available in this environment.');
      },
      vibrate: function (ms) {
        var nav = typeof navigator !== 'undefined' ? navigator : null;
        if (nav && typeof nav.vibrate === 'function') nav.vibrate(ms);
        else log('warning', 'vibrate_pannu: vibration is not supported in this environment (the Android app vibrates).');
      },
    };
  }

  // ------------------------------------------------------------------ runtime
  function createRuntime(ir, host) {
    host = host || {};
    var log = host.log || function () {};
    var storage = host.storage || memoryStorage();
    var prefix = 'ap:' + (host.namespace || ir.app.id) + ':';
    var styleSchema = ir.style_schema || {};
    var inputInfo = scanInputs(ir);
    var inputs = newDict();
    var globals = new Map();
    var screenData = newDict();
    var stack = [];
    var listeners = [];
    var steps = 0, depth = 0, rendering = false;
    var warned = {};
    var rt = { ir: ir, inputInfo: inputInfo };

    function warnOnce(msg) {
      if (!warned[msg]) { warned[msg] = true; log('warning', msg); }
    }
    function tick(pos) {
      if (++steps > LIMITS.steps) throw new ApError('Program ran too long (more than ' + LIMITS.steps + ' steps); it may contain an endless loop.', pos, true);
    }
    function guarded(fn) {
      steps = 0; depth = 0;
      try { return fn(); } catch (e) {
        if (e && e.isApError) throw e;
        if (e instanceof RangeError) throw new ApError('Too much recursion.', null, true);
        throw e;
      }
    }
    function formatError(e) {
      return 'Runtime error' + (e.pos ? ' (line ' + e.pos[0] + ', col ' + e.pos[1] + ')' : '') + ': ' + e.message;
    }

    // ---- input store
    function getInput(name) {
      if (!(name in inputInfo)) throw new ApError("No input component named '" + name + "' exists in this app.");
      return name in inputs ? inputs[name] : inputInfo[name].initial;
    }
    function setInput(name, v) {
      if (!(name in inputInfo)) throw new ApError("No input component named '" + name + "' exists in this app.");
      inputs[name] = coerceInput(inputInfo[name].kind, v, 'input_set');
    }

    // ---- storage API
    function skey(k) {
      need('data', 0, k, 'str');
      if (!k || k.length > LIMITS.keyLength) throw new ApError('Storage keys must be 1-' + LIMITS.keyLength + ' characters.');
      return prefix + k;
    }
    function ownKeys() { return storage.keys().filter(function (k) { return k.indexOf(prefix) === 0; }); }

    // ---- stdlib. effect:true functions are refused while a screen is being drawn.
    var STD = {};
    function def(name, fn, effect) { STD[name] = { fn: fn, effect: !!effect }; }

    def('message_kaattu', function (a) {
      var t = toText(a[0]).slice(0, LIMITS.logLength);
      log('info', 'message: ' + t);
      if (host.message) host.message(t);
      return null;
    }, true);
    def('toast_kaattu', function (a) {
      var t = toText(a[0]).slice(0, LIMITS.logLength);
      log('info', 'toast: ' + t);
      if (host.toast) host.toast(t);
      return null;
    }, true);
    def('debug_log', function (a) { log('debug', toText(a[0]).slice(0, LIMITS.logLength)); return null; });
    def('warning_kaattu', function (a) { log('warning', toText(a[0]).slice(0, LIMITS.logLength)); return null; });
    def('error_kaattu', function (a) { log('error', toText(a[0]).slice(0, LIMITS.logLength)); return null; });

    def('int', function (a) {
      var v = a[0];
      if (typeof v === 'number') return Math.trunc(checkNum(v, 'int value'));
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Math.trunc(Number(v));
      throw new ApError("Cannot convert " + typeOf(v) + (typeof v === 'string' ? ' ' + JSON.stringify(v) : '') + ' to an integer.');
    });
    def('float', function (a) {
      var v = a[0];
      if (typeof v === 'number') return checkNum(v, 'float value');
      if (typeof v === 'string' && /^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(v)) return Number(v);
      throw new ApError("Cannot convert " + typeOf(v) + (typeof v === 'string' ? ' ' + JSON.stringify(v) : '') + ' to a number.');
    });
    def('str', function (a) { return toText(a[0]); });
    def('bool', function (a) { return truthy(a[0]); });
    def('type_of', function (a) { return typeOf(a[0]); });

    def('text_length', function (a) { return need('text_length', 0, a[0], 'str').length; });
    def('text_upper', function (a) { return need('text_upper', 0, a[0], 'str').toUpperCase(); });
    def('text_lower', function (a) { return need('text_lower', 0, a[0], 'str').toLowerCase(); });
    def('text_trim', function (a) { return need('text_trim', 0, a[0], 'str').trim(); });
    def('text_replace', function (a) {
      need('text_replace', 0, a[0], 'str'); need('text_replace', 1, a[1], 'str'); need('text_replace', 2, a[2], 'str');
      if (a[1] === '') throw new ApError('text_replace cannot search for empty text.');
      var out = a[0].split(a[1]).join(a[2]);
      if (out.length > LIMITS.stringLength) throw new ApError('Text is too long.');
      return out;
    });
    def('text_split', function (a) {
      need('text_split', 0, a[0], 'str'); need('text_split', 1, a[1], 'str');
      if (a[1] === '') throw new ApError('text_split needs a non-empty separator.');
      return a[0].split(a[1]);
    });
    def('text_join', function (a) {
      need('text_join', 0, a[0], 'list'); need('text_join', 1, a[1], 'str');
      var out = a[0].map(toText).join(a[1]);
      if (out.length > LIMITS.stringLength) throw new ApError('Text is too long.');
      return out;
    });
    def('text_contains', function (a) { return need('text_contains', 0, a[0], 'str').indexOf(need('text_contains', 1, a[1], 'str')) >= 0; });

    def('length', function (a) {
      var v = a[0];
      if (Array.isArray(v)) return v.length;
      if (isDict(v)) return Object.keys(v).length;
      throw new ApError('length expects a list or dictionary, not ' + typeOf(v) + '. For text use text_length.');
    });
    def('append', function (a) {
      need('append', 0, a[0], 'list');
      if (a[0].length >= LIMITS.listItems) throw new ApError('List is too long (max ' + LIMITS.listItems + ' items).');
      a[0].push(a[1]); return null;
    });
    def('remove', function (a) {
      need('remove', 0, a[0], 'list'); need('remove', 1, a[1], 'num');
      if (!Number.isInteger(a[1]) || a[1] < 0 || a[1] >= a[0].length) throw new ApError('remove: index ' + a[1] + ' is out of range for a list of ' + a[0].length + ' items.');
      return a[0].splice(a[1], 1)[0];
    });
    def('sort', function (a) {
      need('sort', 0, a[0], 'list');
      var l = a[0].slice();
      var allNum = l.every(function (x) { return typeof x === 'number'; });
      var allStr = l.every(function (x) { return typeof x === 'string'; });
      if (!allNum && !allStr) throw new ApError('sort needs a list of only numbers or only text.');
      return l.sort(allNum ? function (x, y) { return x - y; } : function (x, y) { return x < y ? -1 : x > y ? 1 : 0; });
    });
    def('range', function (a) {
      var lo = a.length === 1 ? 0 : need('range', 0, a[0], 'num'), hi = need('range', a.length - 1, a[a.length - 1], 'num');
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new ApError('range needs whole numbers.');
      if (hi - lo > LIMITS.listItems) throw new ApError('range is too large (max ' + LIMITS.listItems + ' items).');
      var out = []; for (var i = lo; i < hi; i++) out.push(i); return out;
    });
    def('dict_get', function (a) {
      need('dict_get', 0, a[0], 'dict'); need('dict_get', 1, a[1], 'str');
      return a[1] in a[0] ? a[0][a[1]] : (a.length > 2 ? a[2] : null);
    });
    def('dict_keys', function (a) { return Object.keys(need('dict_keys', 0, a[0], 'dict')); });

    function numbersOf(fn, a) {
      var items = a.length === 1 ? need(fn, 0, a[0], 'list') : a;
      if (!items.length) throw new ApError(fn + ' needs at least one value.');
      items.forEach(function (x, i) { need(fn, i, x, 'num'); });
      return items;
    }
    def('min', function (a) { return Math.min.apply(null, numbersOf('min', a)); });
    def('max', function (a) { return Math.max.apply(null, numbersOf('max', a)); });
    def('sum', function (a) { return need('sum', 0, a[0], 'list').reduce(function (s, x) { return s + need('sum', 0, x, 'num'); }, 0); });
    def('round', function (a) {
      need('round', 0, a[0], 'num');
      var d = a.length > 1 ? need('round', 1, a[1], 'num') : 0;
      if (!Number.isInteger(d) || d < 0 || d > 10) throw new ApError('round digits must be a whole number from 0 to 10.');
      var f = Math.pow(10, d);
      return Math.round(a[0] * f) / f;
    });
    def('abs', function (a) { return Math.abs(need('abs', 0, a[0], 'num')); });

    def('json_encode', function (a) {
      var s = JSON.stringify(a[0]);
      if (s.length > LIMITS.stringLength) throw new ApError('JSON text is too long.');
      return s;
    });
    def('json_decode', function (a) {
      need('json_decode', 0, a[0], 'str');
      if (a[0].length > LIMITS.stringLength) throw new ApError('JSON text is too long.');
      try { return fromJson(JSON.parse(a[0])); } catch (e) {
        if (e && e.isApError) throw e;
        throw new ApError('json_decode: invalid JSON (' + e.message + ').');
      }
    });
    def('now_iso', function () { return new Date().toISOString(); });
    def('random_number', function (a) {
      need('random_number', 0, a[0], 'num'); need('random_number', 1, a[1], 'num');
      if (!Number.isInteger(a[0]) || !Number.isInteger(a[1]) || a[0] > a[1]) throw new ApError('random_number needs whole numbers with low <= high.');
      return a[0] + Math.floor(Math.random() * (a[1] - a[0] + 1));
    });
    def('random_choice', function (a) {
      need('random_choice', 0, a[0], 'list');
      if (!a[0].length) throw new ApError('random_choice needs a non-empty list.');
      return a[0][Math.floor(Math.random() * a[0].length)];
    });

    def('input_value', function (a) { return getInput(need('input_value', 0, a[0], 'str')); });
    def('input_set', function (a) { setInput(need('input_set', 0, a[0], 'str'), a[1]); return null; }, true);

    def('data_save_pannu', function (a) {
      var k = skey(a[0]), s;
      try { s = JSON.stringify(a[1]); } catch (e) { throw new ApError('data_save_pannu: value cannot be saved (' + e.message + ').'); }
      if (s === undefined || s.length > LIMITS.storageValue) throw new ApError('data_save_pannu: value is too large (max ' + LIMITS.storageValue + ' characters).');
      var total = ownKeys().reduce(function (n, key) { return key === k ? n : n + (storage.getItem(key) || '').length; }, 0) + s.length;
      if (total > LIMITS.storageTotal) throw new ApError('Storage is full (max ' + LIMITS.storageTotal + ' characters per app).');
      try { storage.setItem(k, s); } catch (e) { throw new ApError('Storage is full or unavailable: ' + e.message); }
      return null;
    }, true);
    def('data_edu', function (a) {
      var raw = storage.getItem(skey(a[0]));
      if (raw === null) return a.length > 1 ? a[1] : null;
      try { return fromJson(JSON.parse(raw)); } catch (e) { throw new ApError('Stored value for ' + JSON.stringify(a[0]) + ' is corrupted.'); }
    });
    def('data_delete_pannu', function (a) { storage.removeItem(skey(a[0])); return null; }, true);
    def('data_clear_pannu', function () { ownKeys().forEach(function (k) { storage.removeItem(k); }); return null; }, true);

    var device = host.device || defaultDevice(log);
    def('clipboard_copy', function (a) {
      var t = toText(a[0]);
      if (t.length > LIMITS.storageValue) throw new ApError('clipboard_copy: text is too long.');
      device.clipboard(t); return null;
    }, true);
    def('vibrate_pannu', function (a) {
      need('vibrate_pannu', 0, a[0], 'num');
      if (!Number.isInteger(a[0]) || a[0] < 1 || a[0] > 5000) throw new ApError('vibrate_pannu needs whole milliseconds from 1 to 5000.');
      device.vibrate(a[0]); return null;
    }, true);

    def('screen_ku_poo', function (a) {
      need('screen_ku_poo', 0, a[0], 'str');
      if (!ir.screens[a[0]]) throw new ApError("Screen '" + a[0] + "' does not exist.");
      stack.push(a[0]); return null;
    }, true);
    def('screen_back_poo', function () { if (stack.length > 1) stack.pop(); return null; }, true);
    def('screen_data_set', function (a) { screenData[need('screen_data_set', 0, a[0], 'str')] = a[1]; return null; }, true);
    def('screen_data_get', function (a) {
      need('screen_data_get', 0, a[0], 'str');
      return a[0] in screenData ? screenData[a[0]] : (a.length > 1 ? a[1] : null);
    });

    // ---- evaluation
    function lookup(name, env, pos) {
      if (env.has(name)) return env.get(name);
      if (globals.has(name)) return globals.get(name);
      throw new ApError("Variable '" + name + "' has no value yet.", pos);
    }
    function evalExpr(e, env) {
      tick(e.pos);
      switch (e.t) {
        case 'num': case 'str': case 'bool': return e.v;
        case 'null': return null;
        case 'name': return lookup(e.n, env, e.pos);
        case 'list': {
          if (e.items.length > LIMITS.listItems) throw new ApError('List literal is too long.', e.pos);
          return e.items.map(function (x) { return evalExpr(x, env); });
        }
        case 'dict': {
          var d = newDict();
          e.items.forEach(function (kv) {
            var k = evalExpr(kv[0], env);
            if (typeof k !== 'string') throw new ApError('Dictionary keys must be text, not ' + typeOf(k) + '.', kv[0].pos);
            d[k] = evalExpr(kv[1], env);
          });
          return d;
        }
        case 'un': {
          var v = evalExpr(e.e, env);
          if (e.op === 'not') return !truthy(v);
          if (typeof v !== 'number') throw new ApError("Cannot negate " + typeOf(v) + '.', e.pos);
          return -v;
        }
        case 'bin': return evalBin(e, env);
        case 'index': return evalIndex(evalExpr(e.e, env), evalExpr(e.i, env), e.pos);
        case 'call': return evalCall(e, env);
      }
      throw new ApError('Unsupported expression type ' + e.t + '.', e.pos);
    }
    function evalBin(e, env) {
      var op = e.op;
      if (op === 'and') { var l = evalExpr(e.l, env); return truthy(l) ? truthy(evalExpr(e.r, env)) : false; }
      if (op === 'or') { var l2 = evalExpr(e.l, env); return truthy(l2) ? true : truthy(evalExpr(e.r, env)); }
      var a = evalExpr(e.l, env), b = evalExpr(e.r, env);
      if (op === '==') return deepEqual(a, b);
      if (op === '!=') return !deepEqual(a, b);
      var ta = typeOf(a), tb = typeOf(b);
      if (op === '+') {
        if (ta === 'number' && tb === 'number') return finite(a + b, e);
        if (ta === 'text' && tb === 'text') {
          if (a.length + b.length > LIMITS.stringLength) throw new ApError('Text is too long.', e.pos);
          return a + b;
        }
        if (ta === 'list' && tb === 'list') return a.concat(b);
        throw new ApError("Cannot use '+' between " + ta + ' and ' + tb + '.' + (ta === 'text' || tb === 'text' ? ' Use str(...) to convert numbers to text.' : ''), e.pos);
      }
      if (op === '<' || op === '>' || op === '<=' || op === '>=') {
        if (!((ta === 'number' && tb === 'number') || (ta === 'text' && tb === 'text'))) throw new ApError("Cannot compare " + ta + " with " + tb + " using '" + op + "'.", e.pos);
        return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
      }
      if (ta !== 'number' || tb !== 'number') throw new ApError("Cannot use '" + op + "' between " + ta + ' and ' + tb + '.', e.pos);
      if (op === '-') return finite(a - b, e);
      if (op === '*') return finite(a * b, e);
      if (b === 0) throw new ApError('Division by zero.', e.pos);
      return op === '/' ? finite(a / b, e) : a % b;
    }
    function finite(n, e) {
      if (!isFinite(n)) throw new ApError('Number is too large.', e.pos);
      return n;
    }
    function evalIndex(base, idx, pos) {
      if (Array.isArray(base)) {
        if (typeof idx !== 'number' || !Number.isInteger(idx)) throw new ApError('List index must be a whole number.', pos);
        if (idx < 0 || idx >= base.length) throw new ApError('List index ' + idx + ' is out of range (list has ' + base.length + ' items).', pos);
        return base[idx];
      }
      if (typeof base === 'string') {
        if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= base.length) throw new ApError('Text index out of range.', pos);
        return base.charAt(idx);
      }
      if (isDict(base)) {
        if (typeof idx !== 'string') throw new ApError('Dictionary keys must be text.', pos);
        if (!(idx in base)) throw new ApError('Key ' + JSON.stringify(idx) + ' not found. Use dict_get(d, key, default) for optional keys.', pos);
        return base[idx];
      }
      throw new ApError('Cannot index into ' + typeOf(base) + '.', pos);
    }
    function evalCall(e, env) {
      var args = e.args.map(function (a) { return evalExpr(a, env); });
      return invoke(e.f, args, e.pos);
    }
    function invoke(name, args, pos) {
      var fn = ir.functions[name];
      if (fn) return callUser(name, fn, args, pos);
      var s = STD[name];
      if (!s) throw new ApError("Unknown function '" + name + "'.", pos);
      if (s.effect && rendering) throw new ApError(name + ' cannot be used while the screen is being drawn; call it from a button/event handler function.', pos);
      return s.fn(args);
    }
    function callUser(name, fn, args, pos) {
      if (args.length !== fn.params.length) throw new ApError("Function '" + name + "' expects " + fn.params.length + ' argument(s).', pos);
      if (++depth > LIMITS.depth) throw new ApError('Too much recursion (more than ' + LIMITS.depth + ' nested calls).', pos, true);
      var env = new Map();
      fn.params.forEach(function (p, i) { env.set(p, args[i]); });
      try {
        var r = execBlock(fn.body, env, null);
        return r ? r.v : null;
      } finally { depth--; }
    }

    // ---- statements. `frame` is non-null while drawing a screen: {kids, title}
    function execBlock(stmts, env, frame) {
      for (var i = 0; i < stmts.length; i++) {
        var r = exec(stmts[i], env, frame);
        if (r) return r;
      }
      return null;
    }
    function exec(st, env, frame) {
      tick(st.pos);
      try { return execInner(st, env, frame); } catch (err) {
        if (err && err.isApError && !err.pos) err.pos = st.pos;
        throw err;
      }
    }
    function execInner(st, env, frame) {
      switch (st.t) {
        case 'let': env.set(st.n, evalExpr(st.e, env)); return null;
        case 'assign': assign(st, env); return null;
        case 'if': {
          for (var i = 0; i < st.branches.length; i++) {
            if (truthy(evalExpr(st.branches[i].cond, env))) return execBlock(st.branches[i].body, env, frame);
          }
          return st.else ? execBlock(st.else, env, frame) : null;
        }
        case 'for': {
          var it = evalExpr(st.iter, env), items;
          if (Array.isArray(it)) items = it;
          else if (typeof it === 'string') items = it.split('');
          else if (isDict(it)) items = Object.keys(it);
          else throw new ApError('Cannot loop over ' + typeOf(it) + '. To repeat N times use: ovvoru i in range(N):', st.pos);
          for (var k = 0; k < items.length; k++) {
            env.set(st.v, items[k]);
            var r = execBlock(st.body, env, frame);
            if (r) return r;
          }
          return null;
        }
        case 'while': {
          while (truthy(evalExpr(st.cond, env))) {
            tick(st.pos);
            var r2 = execBlock(st.body, env, frame);
            if (r2) return r2;
          }
          return null;
        }
        case 'return': return { v: st.e ? evalExpr(st.e, env) : null };
        case 'try': {
          try { return execBlock(st.body, env, frame); } catch (err) {
            if (!err || !err.isApError || err.fatal) throw err;
            env.set(st.var, err.message);
            return execBlock(st.handler, env, frame);
          }
        }
        case 'summa': return null;
        case 'call_stmt': evalCall(st, env); return null;
        case 'screen_title': if (frame) frame.title = toText(evalExpr(st.e, env)); return null;
        case 'comp': if (!frame) throw new ApError('UI components can only be drawn inside a screen.', st.pos); frame.kids.push(buildComponent(st, env)); return null;
      }
      throw new ApError('Unsupported statement ' + st.t + '.', st.pos);
    }
    function assign(st, env) {
      var v = evalExpr(st.e, env), t = st.target;
      if (t.t === 'name') {
        if (env.has(t.n)) env.set(t.n, v);
        else if (globals.has(t.n)) {
          if (rendering) throw new ApError("Screens cannot change global '" + t.n + "' while drawing; change it in an event handler.", st.pos);
          globals.set(t.n, v);
        } else throw new ApError("Variable '" + t.n + "' is not declared.", st.pos);
        return;
      }
      var base = evalExpr(t.e, env), idx = evalExpr(t.i, env);
      if (Array.isArray(base)) {
        if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= base.length) throw new ApError('List index ' + toText(idx) + ' is out of range.', st.pos);
        base[idx] = v;
      } else if (isDict(base)) {
        if (typeof idx !== 'string') throw new ApError('Dictionary keys must be text.', st.pos);
        base[idx] = v;
      } else throw new ApError('Cannot assign into ' + typeOf(base) + '.', st.pos);
    }

    // ---- component view tree
    function buildComponent(n, env) {
      var props = {};
      Object.keys(n.props).forEach(function (k) { props[k] = evalExpr(n.props[k], env); });
      var view = { c: n.c, props: normalizeProps(n.c, props, n.pos), events: n.events || {}, style: {}, pos: n.pos };
      if (n.style) {
        var raw = evalExpr(n.style, env), res = validateStyle(raw, styleSchema);
        view.style = res.valid;
        res.problems.forEach(function (p) { warnOnce('Style ignored on ' + n.c + ' (line ' + n.pos[0] + '): ' + p + '.'); });
      }
      if (n.children) {
        var inner = { kids: [], title: null };
        execBlock(n.children, env, inner);
        view.children = inner.kids;
      }
      return view;
    }
    function normalizeProps(c, p, pos) {
      var out = {}, kind = INPUT_KIND[c];
      function text(k, d) { out[k] = p[k] === undefined ? d : toText(p[k]); }
      function bool(k, d) {
        if (p[k] === undefined) { out[k] = d; return; }
        if (typeof p[k] !== 'boolean') throw new ApError(c + " option '" + k + "' must be true or false.", pos);
        out[k] = p[k];
      }
      if (c === 'title' || c === 'text_kaattu') text('text', '');
      else if (c === 'button') { text('label', ''); bool('enabled', true); }
      else if (kind) {
        text('name', ''); text('label', ''); bool('enabled', true);
        if (kind === 'text' || kind === 'password' || kind === 'number') text('placeholder', '');
        if (kind === 'dropdown') {
          if (!Array.isArray(p.options) || !p.options.length) throw new ApError('dropdown_uruvakku needs options=[...] with at least one item.', pos);
          out.options = p.options.map(toText);
        }
        if (!(p.name in inputs)) {
          var init = p.initial === undefined ? (kind === 'dropdown' ? out.options[0] : defaultInput(kind)) : p.initial;
          if (kind === 'dropdown') { init = toText(init); if (out.options.indexOf(init) < 0) init = out.options[0]; }
          inputs[p.name] = coerceInput(kind, init, c);
        } else if (kind === 'dropdown' && out.options.indexOf(inputs[p.name]) < 0) inputs[p.name] = out.options[0];
        out.value = inputs[p.name];
      } else if (c === 'image_kaattu') {
        text('alt', '');
        var src = toText(p.src);
        if (/^https:\/\//i.test(src) || /^data:image\/(png|jpeg|gif|webp);/i.test(src)) out.src = src;
        else { warnOnce("image_kaattu (line " + pos[0] + "): src must be an https:// URL or data:image URI; image not shown."); out.src = ''; }
      } else if (c === 'list_kaattu') {
        if (!Array.isArray(p.items)) throw new ApError('list_kaattu needs a list, not ' + typeOf(p.items) + '.', pos);
        out.items = p.items.map(toText);
      } else if (c === 'progress_kaattu') {
        if (typeof p.value !== 'number' || !isFinite(p.value)) throw new ApError('progress_kaattu value must be a number from 0 to 100.', pos);
        out.value = Math.max(0, Math.min(100, p.value)); text('label', '');
      } else if (c === 'loading_kaattu') text('label', '');
      return out;
    }

    // ---- public API
    rt.subscribe = function (fn) { listeners.push(fn); };
    function notify() { listeners.forEach(function (fn) { fn(); }); }
    rt.format = formatError;
    rt.currentScreen = function () { return stack[stack.length - 1]; };
    rt.canGoBack = function () { return stack.length > 1; };
    /** Design/preview tooling: show a specific screen (resets navigation history). */
    rt.setScreen = function (name) {
      if (!ir.screens[name]) return false;
      stack = [name]; notify(); return true;
    };
    rt.globals = globals;

    rt.init = function () {
      stack = [ir.app.start_screen];
      globals.clear();
      guarded(function () { rendering = false; ir.globals.forEach(function (g) { exec(g, globals, null); }); });
    };
    /** Build the view tree for the current screen. Throws ApError on runtime errors. */
    rt.render = function () {
      var name = stack[stack.length - 1], sc = ir.screens[name];
      return guarded(function () {
        rendering = true;
        try {
          var frame = { kids: [], title: null }, env = new Map();
          execBlock(sc.body, env, frame);
          var style = {};
          if (sc.style) {
            var res = validateStyle(evalExpr(sc.style, env), styleSchema);
            style = res.valid;
            res.problems.forEach(function (p) { warnOnce('Style ignored on screen ' + name + ': ' + p + '.'); });
          }
          return { screen: name, title: frame.title === null ? ir.app.name : frame.title, style: style, children: frame.kids };
        } finally { rendering = false; }
      });
    };
    /** Run an event handler by function name. Errors are logged, never thrown. */
    rt.fire = function (handlerName) {
      try {
        guarded(function () { rendering = false; callUser(handlerName, ir.functions[handlerName], [], null); });
      } catch (e) {
        if (!e || !e.isApError) throw e;
        log('error', "In handler '" + handlerName + "': " + formatError(e));
        if (host.toast) host.toast('Error: ' + e.message);
      }
      notify();
    };
    rt.setInputFromUI = function (name, value) {
      try { inputs[name] = coerceInput(inputInfo[name].kind, value, 'input'); } catch (e) { log('warning', e.message); }
    };
    rt.goBack = function () {
      if (stack.length > 1) { stack.pop(); notify(); return true; }
      return false;
    };
    rt.getInput = getInput;
    rt.callFunction = function (name, args) { return guarded(function () { return callUser(name, ir.functions[name], args || [], null); }); };
    rt.stdlibNames = Object.keys(STD);
    return rt;
  }

  // ------------------------------------------------------------------ DOM renderer
  var CSS = [
    '.ap-root{--bg:#f9fafb;--fg:#111827;--surface:#fff;--border:#d1d5db;--accent:#2563eb;--on-accent:#fff;--muted:#6b7280;--bar:#fff;',
    'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;box-sizing:border-box}',
    '.ap-root[data-theme=dark]{--bg:#0f172a;--fg:#f1f5f9;--surface:#1e293b;--border:#475569;--accent:#3b82f6;--muted:#94a3b8;--bar:#1e293b}',
    '.ap-root *{box-sizing:border-box}',
    '.ap-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:var(--bar);border-bottom:1px solid var(--border);font-weight:600;flex:none}',
    '.ap-bar button{border:0;background:none;color:inherit;font-size:20px;line-height:1;padding:4px 8px;cursor:pointer;border-radius:6px}',
    '.ap-screen{flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;color:var(--fg)}',
    '.ap-flow{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;min-width:0}',
    '.ap-row{flex-direction:row;align-items:center}',
    '.ap-center{flex:1 1 auto;align-items:center;justify-content:center}',
    '.ap-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.12)}',
    '.ap-title{font-size:24px;font-weight:700;margin:0;overflow-wrap:anywhere}',
    '.ap-text{margin:0;overflow-wrap:anywhere}',
    '.ap-btn{border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;background:var(--accent);color:var(--on-accent);cursor:pointer}',
    '.ap-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.ap-field{display:flex;flex-direction:column;gap:4px}',
    '.ap-field>label,.ap-check label{font-size:14px;color:var(--muted)}',
    '.ap-field input,.ap-field select{font:inherit;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit;width:100%}',
    '.ap-check{display:flex;align-items:center;gap:10px}',
    '.ap-check label{color:inherit;font-size:inherit}',
    '.ap-check input{width:20px;height:20px;accent-color:var(--accent)}',
    '.ap-switch{width:44px;height:26px;appearance:none;-webkit-appearance:none;border-radius:13px;background:var(--border);position:relative;cursor:pointer;transition:background .15s;flex:none}',
    '.ap-switch::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}',
    '.ap-switch:checked{background:var(--accent)}.ap-switch:checked::after{left:21px}',
    '.ap-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
    '.ap-list li{padding:10px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}',
    '.ap-divider{border:0;border-top:1px solid var(--border);width:100%;margin:0}',
    '.ap-progress{width:100%;color:var(--accent)}.ap-progress progress{width:100%;height:10px;border:0;border-radius:6px;overflow:hidden;appearance:none;-webkit-appearance:none;background:rgba(128,128,128,.35);color:inherit}',
    '.ap-progress progress::-webkit-progress-bar{background:rgba(128,128,128,.35);border-radius:6px}',
    '.ap-progress progress::-webkit-progress-value{background:currentColor;border-radius:6px}',
    '.ap-progress progress::-moz-progress-bar{background:currentColor;border-radius:6px}',
    '.ap-spinner{width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:ap-spin 1s linear infinite}',
    '@keyframes ap-spin{to{transform:rotate(360deg)}}',
    '.ap-image{max-width:100%;display:block}',
    '.ap-error{margin:16px;padding:16px;border:1px solid #dc2626;border-radius:8px;background:rgba(220,38,38,.08);color:#b91c1c;white-space:pre-wrap;font-size:14px}',
    '.ap-overlay{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px;z-index:10}',
    '.ap-dialog{background:var(--surface);color:var(--fg);border-radius:14px;padding:20px;max-width:100%;width:100%;display:flex;flex-direction:column;gap:16px;overflow-wrap:anywhere}',
    '.ap-root[data-design] [data-ap-line]{cursor:grab}',
    '.ap-root[data-design] input,.ap-root[data-design] select,.ap-root[data-design] label{pointer-events:none}',
    '.ap-root[data-design] [data-ap-line]:hover{outline:1px dashed #2563eb;outline-offset:-1px}',
    '.ap-root[data-design] .ap-selected{outline:2px solid #2563eb!important;outline-offset:-2px}',
    '.ap-empty{min-height:56px;border:1.5px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center}',
    '.ap-empty::after{content:"Drop components here";color:var(--muted);font-size:12px}',
    '.ap-drop-inside{outline:2px dashed #2563eb!important;outline-offset:-2px;background-image:linear-gradient(rgba(37,99,235,.08),rgba(37,99,235,.08))}',
    '.ap-drop-ind{position:absolute;background:#2563eb;pointer-events:none;z-index:20;border-radius:2px;display:none}',
    '.ap-toast{position:absolute;left:16px;right:16px;bottom:24px;background:#111827;color:#fff;padding:10px 14px;border-radius:10px;z-index:11;font-size:14px;text-align:center;overflow-wrap:anywhere}',
  ].join('\n');

  var ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
  var JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', space_between: 'space-between', space_around: 'space-around' };
  var WEIGHT = { normal: '400', medium: '500', bold: '700' };

  function applyStyle(el, s, isCol) {
    function px(n) { return n + 'px'; }
    function size(v, dim) {
      if (typeof v === 'number') return px(v);
      return v === 'fill' ? (dim === 'w' ? '100%' : null) : v;
    }
    if ('background' in s) el.style.background = s.background;
    if ('text_color' in s) el.style.color = s.text_color;
    if ('border_color' in s) el.style.borderColor = s.border_color;
    if ('padding' in s) el.style.padding = px(s.padding);
    if ('margin' in s) el.style.margin = px(s.margin);
    if ('gap' in s) el.style.gap = px(s.gap);
    if ('corner_radius' in s) el.style.borderRadius = px(s.corner_radius);
    if ('border_width' in s) { el.style.borderWidth = px(s.border_width); el.style.borderStyle = 'solid'; if (!('border_color' in s)) el.style.borderColor = 'var(--border)'; }
    if ('font_size' in s) el.style.fontSize = px(s.font_size);
    if ('font_weight' in s) el.style.fontWeight = WEIGHT[s.font_weight];
    if ('text_align' in s) el.style.textAlign = s.text_align;
    if ('opacity' in s) el.style.opacity = String(s.opacity);
    if ('visible' in s && !s.visible) el.style.display = 'none';
    if ('width' in s) { var w = size(s.width, 'w'); if (w) el.style.width = w; }
    if ('height' in s) { if (s.height === 'fill') el.style.flex = '1 1 0'; else el.style.height = size(s.height, 'h'); }
    if ('align' in s) el.style.alignItems = ALIGN[s.align];
    if ('justify' in s) el.style.justifyContent = JUSTIFY[s.justify];
    if ('wrap' in s) el.style.flexWrap = s.wrap ? 'wrap' : 'nowrap';
    if ('scroll' in s) el.style.overflow = s.scroll ? 'auto' : 'hidden';
  }

  function mount(ir, rootEl, host) {
    host = host || {};
    var doc = rootEl.ownerDocument;
    var toastTimer = null;
    var uid = 0;
    var rt = null;
    var composing = false;
    // Design mode (Studio designer): components are selectable/draggable, events do not run, and drops are reported.
    var design = host.design || null;
    var selectedLine = design && design.selectedLine ? design.selectedLine : null;
    var dragEl = null;
    var CONTAINERS = { card_uruvakku: 1, column_uruvakku: 1, row_uruvakku: 1, center_ama: 1 };

    var styleEl = doc.createElement('style');
    styleEl.textContent = CSS;
    rootEl.appendChild(styleEl);
    var app = doc.createElement('div');
    app.className = 'ap-root';
    app.setAttribute('data-theme', ir.app.theme === 'dark' ? 'dark' : 'light');
    if (design) app.setAttribute('data-design', '1');
    rootEl.appendChild(app);
    var indicator = el0('div', 'ap-drop-ind');
    app.appendChild(indicator);
    function el0(tag, cls) { var e = doc.createElement(tag); e.className = cls; return e; }

    function el(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }
    function showToast(text) {
      var old = app.querySelector('.ap-toast');
      if (old) old.remove();
      var t = el('div', 'ap-toast', text);
      t.setAttribute('role', 'status');
      app.appendChild(t);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.remove(); }, 2500);
    }
    function showMessage(text) {
      var ov = el('div', 'ap-overlay');
      var dlg = el('div', 'ap-dialog');
      dlg.setAttribute('role', 'alertdialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.appendChild(el('div', '', text));
      var ok = el('button', 'ap-btn', 'OK');
      ok.addEventListener('click', function () { ov.remove(); });
      dlg.appendChild(ok);
      ov.appendChild(dlg);
      app.appendChild(ov);
      ok.focus();
    }

    var realHost = {
      namespace: host.namespace,
      storage: host.storage || webStorage(),
      log: host.log || function () {},
      toast: function (t) { showToast(t); if (host.toast) host.toast(t); },
      message: function (t) { showMessage(t); if (host.message) host.message(t); },
    };
    rt = createRuntime(ir, realHost);

    function buildView(v) {
      var s = v.style, node, c = v.c, p = v.props;
      if (c === 'title') { node = el('h1', 'ap-title', p.text); node.setAttribute('role', 'heading'); node.setAttribute('aria-level', '1'); }
      else if (c === 'text_kaattu') node = el('p', 'ap-text', p.text);
      else if (c === 'button') {
        node = el('button', 'ap-btn', p.label);
        node.type = 'button';
        node.disabled = !p.enabled && !design; // in design mode a disabled button must still be selectable
        if (design && !p.enabled) node.style.opacity = '0.5';
        var h = v.events.click_pannumbodhu;
        if (h && !design) node.addEventListener('click', function () { rt.fire(h); });
      } else if (INPUT_KIND[c]) node = buildInput(v);
      else if (c === 'image_kaattu') { node = el('img', 'ap-image'); if (p.src) node.src = p.src; node.alt = p.alt; }
      else if (c === 'list_kaattu') {
        node = el('ul', 'ap-list');
        p.items.forEach(function (t) { node.appendChild(el('li', '', t)); });
      } else if (c === 'progress_kaattu') {
        node = el('div', 'ap-progress');
        var pr = el('progress'); pr.max = 100; pr.value = p.value;
        pr.setAttribute('aria-valuenow', String(p.value));
        pr.setAttribute('aria-label', p.label || 'Progress');
        if (p.label) node.appendChild(el('div', '', p.label));
        node.appendChild(pr);
      } else if (c === 'loading_kaattu') {
        node = el('div', 'ap-flow ap-center');
        node.style.flex = '0 0 auto';
        node.setAttribute('role', 'status');
        node.appendChild(el('div', 'ap-spinner'));
        if (p.label) node.appendChild(el('div', '', p.label));
      } else if (c === 'divider_kaattu') { node = el('hr', 'ap-divider'); }
      else {
        node = el('div', 'ap-flow' + (c === 'row_uruvakku' ? ' ap-row' : '') + (c === 'center_ama' ? ' ap-center' : '') + (c === 'card_uruvakku' ? ' ap-card' : ''));
        (v.children || []).forEach(function (k) { node.appendChild(buildView(k)); });
      }
      applyStyle(node, s);
      if (design) {
        node.setAttribute('data-ap-line', String(v.pos[0]));
        node.setAttribute('data-ap-c', c);
        node.draggable = true;
        if (CONTAINERS[c]) {
          node.setAttribute('data-ap-container', '1');
          if (!(v.children || []).length) node.classList.add('ap-empty');
        }
      }
      return node;
    }

    function buildInput(v) {
      var p = v.props, kind = INPUT_KIND[v.c], id = 'ap-in-' + (++uid), wrap, input;
      var change = v.events.change_aagumbodhu, submit = v.events.submit_pannumbodhu;
      function onValue(val) {
        if (design) return;
        rt.setInputFromUI(p.name, val);
        if (change) rt.fire(change); else render();
      }
      if (kind === 'checkbox' || kind === 'toggle') {
        wrap = el('div', 'ap-check');
        input = el('input', kind === 'toggle' ? 'ap-switch' : '');
        input.type = 'checkbox';
        input.id = id;
        input.checked = p.value;
        if (kind === 'toggle') input.setAttribute('role', 'switch');
        input.addEventListener('change', function () { onValue(input.checked); });
        wrap.appendChild(input);
        if (p.label) { var lb = el('label', '', p.label); lb.htmlFor = id; wrap.appendChild(lb); }
      } else {
        wrap = el('div', 'ap-field');
        if (p.label) { var l = el('label', '', p.label); l.htmlFor = id; wrap.appendChild(l); }
        if (kind === 'dropdown') {
          input = el('select');
          p.options.forEach(function (o) { var op = el('option', '', o); op.value = o; input.appendChild(op); });
          input.value = p.value;
          input.addEventListener('change', function () { onValue(input.value); });
        } else {
          input = el('input');
          input.type = kind;
          input.id = id;
          if (kind === 'number') input.step = 'any';
          input.value = p.value === null ? '' : String(p.value);
          input.placeholder = p.placeholder;
          input.addEventListener('compositionstart', function () { composing = true; });
          input.addEventListener('compositionend', function () { composing = false; onValue(input.value); });
          input.addEventListener('input', function () {
            if (composing) return;
            var val = kind === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
            if (val !== null && typeof val === 'number' && !isFinite(val)) return;
            onValue(val);
          });
          if (submit) input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') rt.fire(submit); });
        }
        input.id = id;
        wrap.appendChild(input);
      }
      input.disabled = !p.enabled;
      input.setAttribute('data-ap-input', p.name);
      return wrap;
    }

    function render() {
      var root = app.getRootNode ? app.getRootNode() : doc;
      var active = (root && root.activeElement) || doc.activeElement, restore = null;
      if (active && app.contains(active) && active.getAttribute && active.getAttribute('data-ap-input')) {
        restore = { name: active.getAttribute('data-ap-input') };
        try { restore.s = active.selectionStart; restore.e = active.selectionEnd; } catch (e) { /* not selectable */ }
      }
      var prevScreen = app.getAttribute('data-screen'), prevScroll = 0;
      var oldMain = app.querySelector('.ap-screen');
      if (oldMain) prevScroll = oldMain.scrollTop;
      Array.prototype.slice.call(app.children).forEach(function (c) { if (!/ap-overlay|ap-toast|ap-drop-ind/.test(c.className)) c.remove(); });

      var view;
      try { view = rt.render(); } catch (e) {
        if (!e || !e.isApError) throw e;
        realHost.log('error', rt.format(e));
        var errBox = el('div', 'ap-error', 'This screen has an error and cannot be drawn.\n\n' + rt.format(e));
        errBox.setAttribute('role', 'alert');
        app.insertBefore(errBox, app.firstChild);
        app.insertBefore(el('div', 'ap-bar', ir.app.name), errBox);
        return;
      }
      var bar = el('div', 'ap-bar');
      if (rt.canGoBack()) {
        var back = el('button', '', '\u2190');
        back.type = 'button';
        back.setAttribute('aria-label', 'Back');
        back.addEventListener('click', function () { rt.goBack(); });
        bar.appendChild(back);
      }
      bar.appendChild(el('span', '', view.title));
      var main = el('div', 'ap-screen');
      main.setAttribute('role', 'main');
      view.children.forEach(function (k) { main.appendChild(buildView(k)); });
      applyStyle(main, view.style);
      if (design) {
        main.setAttribute('data-ap-screen', view.screen);
        if (!view.children.length) main.classList.add('ap-empty');
      }
      app.insertBefore(main, app.firstChild);
      app.insertBefore(bar, main);
      app.setAttribute('data-screen', view.screen);
      if (prevScreen === view.screen) main.scrollTop = prevScroll;
      if (design) {
        applySelection();
        if (design.onTree) design.onTree({ screen: view.screen, screens: ir.screen_order, title: view.title, children: outline(view.children) });
      }
      if (restore) {
        var target = app.querySelector('[data-ap-input="' + restore.name.replace(/["\\]/g, '\\$&') + '"]');
        if (target) {
          target.focus();
          if (restore.s != null) { try { target.setSelectionRange(restore.s, restore.e); } catch (e) { /* ignore */ } }
        }
      }
    }
    function label(v) {
      var p = v.props || {};
      return p.text || p.label || p.name || p.src || (p.items && p.items.length + ' items') || '';
    }
    function outline(list) {
      return list.map(function (v) { return { c: v.c, line: v.pos[0], label: String(label(v)).slice(0, 40), children: v.children ? outline(v.children) : null }; });
    }
    function applySelection() {
      Array.prototype.forEach.call(app.querySelectorAll('.ap-selected'), function (e) { e.classList.remove('ap-selected'); });
      if (selectedLine == null) return;
      var e = app.querySelector('[data-ap-line="' + selectedLine + '"]');
      if (e) e.classList.add('ap-selected');
    }
    function select(line, silent) {
      selectedLine = line;
      applySelection();
      if (!silent && design && design.onSelect) design.onSelect(line);
    }

    // ---- design mode: selection + drag and drop
    function zoneFor(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-ap-line]') : null;
      if (t && !app.contains(t)) t = null;
      if (dragEl && t && (t === dragEl || dragEl.contains(t))) return null;
      if (!t) return { el: null, position: 'inside' };
      var r = t.getBoundingClientRect(), par = t.parentElement;
      var row = !!par && /^row/.test(doc.defaultView.getComputedStyle(par).flexDirection);
      var ratio = row ? (ev.clientX - r.left) / (r.width || 1) : (ev.clientY - r.top) / (r.height || 1);
      if (t.hasAttribute('data-ap-container')) return { el: t, position: ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside', row: row };
      return { el: t, position: ratio < 0.5 ? 'before' : 'after', row: row };
    }
    function clearZone() {
      indicator.style.display = 'none';
      Array.prototype.forEach.call(app.querySelectorAll('.ap-drop-inside'), function (e) { e.classList.remove('ap-drop-inside'); });
    }
    function showZone(z) {
      clearZone();
      if (!z) return;
      if (z.position === 'inside') {
        (z.el || app.querySelector('.ap-screen')).classList.add('ap-drop-inside');
        return;
      }
      var ar = app.getBoundingClientRect(), r = z.el.getBoundingClientRect(), before = z.position === 'before';
      indicator.style.display = 'block';
      if (z.row) {
        indicator.style.left = (before ? r.left : r.right) - ar.left - 1 + 'px';
        indicator.style.top = r.top - ar.top + 'px';
        indicator.style.width = '3px';
        indicator.style.height = r.height + 'px';
      } else {
        indicator.style.top = (before ? r.top : r.bottom) - ar.top - 1 + 'px';
        indicator.style.left = r.left - ar.left + 'px';
        indicator.style.height = '3px';
        indicator.style.width = r.width + 'px';
      }
    }
    function hasType(ev, type) {
      var ts = ev.dataTransfer && ev.dataTransfer.types;
      return !!ts && Array.prototype.indexOf.call(ts, type) >= 0;
    }
    if (design) {
      app.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var t = ev.target.closest ? ev.target.closest('[data-ap-line]') : null;
        select(t ? Number(t.getAttribute('data-ap-line')) : null);
      }, true);
      app.addEventListener('dragstart', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-ap-line]') : null;
        if (!t) { ev.preventDefault(); return; }
        dragEl = t;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('application/x-apppanrom-move', t.getAttribute('data-ap-line'));
        ev.dataTransfer.setData('text/plain', 'apppanrom-move');
      });
      app.addEventListener('dragend', function () { dragEl = null; clearZone(); });
      app.addEventListener('dragover', function (ev) {
        if (!hasType(ev, 'application/x-apppanrom-new') && !hasType(ev, 'application/x-apppanrom-move')) return;
        var z = zoneFor(ev);
        if (!z) { clearZone(); return; }
        ev.preventDefault();
        ev.dataTransfer.dropEffect = hasType(ev, 'application/x-apppanrom-new') ? 'copy' : 'move';
        showZone(z);
      });
      app.addEventListener('dragleave', function (ev) { if (!ev.relatedTarget || !app.contains(ev.relatedTarget)) clearZone(); });
      app.addEventListener('drop', function (ev) {
        var isNew = hasType(ev, 'application/x-apppanrom-new'), isMove = hasType(ev, 'application/x-apppanrom-move');
        if (!isNew && !isMove) return;
        ev.preventDefault();
        var z = zoneFor(ev);
        clearZone();
        if (!z) return;
        var info = {
          source: isNew ? 'new' : 'move',
          target_line: z.el ? Number(z.el.getAttribute('data-ap-line')) : null,
          position: z.position,
          screen: rt.currentScreen(),
        };
        if (isNew) info.type = ev.dataTransfer.getData('application/x-apppanrom-new');
        else info.line = Number(ev.dataTransfer.getData('application/x-apppanrom-move'));
        dragEl = null;
        if (design.onDrop) design.onDrop(info);
      });
    }

    try { rt.init(); } catch (e) {
      if (!e || !e.isApError) throw e;
      realHost.log('error', 'Startup failed. ' + rt.format(e));
      var startBox = el('div', 'ap-error', 'The app could not start.\n\n' + rt.format(e));
      startBox.setAttribute('role', 'alert');
      app.appendChild(startBox);
      return { runtime: rt, goBack: function () { return false; }, destroy: function () { rootEl.removeChild(app); rootEl.removeChild(styleEl); } };
    }
    if (design && design.screen) rt.setScreen(design.screen);
    rt.subscribe(render);
    render();
    return {
      /** Design mode: swap in a freshly compiled IR in place (keeps the current screen, selection and scroll). */
      update: function (newIr) {
        var screen = rt.currentScreen();
        ir = newIr;
        app.setAttribute('data-theme', ir.app.theme === 'dark' ? 'dark' : 'light');
        rt = createRuntime(ir, realHost);
        try { rt.init(); } catch (e) {
          if (!e || !e.isApError) throw e;
          realHost.log('error', 'Startup failed. ' + rt.format(e));
          return;
        }
        if (ir.screens[screen]) rt.setScreen(screen);
        rt.subscribe(render);
        render();
      },
      runtime: rt,
      select: function (line) { select(line, true); },
      setScreen: function (name) { return rt.setScreen(name); },
      currentScreen: function () { return rt.currentScreen(); },
      scrollTop: function () { var m = app.querySelector('.ap-screen'); return m ? m.scrollTop : 0; },
      goBack: function () { return rt.goBack(); },
      destroy: function () { clearTimeout(toastTimer); if (app.parentNode) app.parentNode.removeChild(app); if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); },
    };
  }

  return {
    version: VERSION,
    LIMITS: LIMITS,
    COMPONENT_NAMES: COMPONENT_NAMES,
    createRuntime: createRuntime,
    mount: mount,
    memoryStorage: memoryStorage,
    validateStyle: validateStyle,
    stdlibNames: function () {
      return createRuntime({ app: { id: 'x', name: 'x', start_screen: 's' }, screens: { s: { body: [] } }, functions: {}, globals: [] }).stdlibNames;
    },
  };
});
