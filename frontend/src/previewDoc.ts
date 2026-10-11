import runtimeSource from '../../runtime/apppanrom-runtime.js?raw';

/** Escapes text for safe embedding inside an inline <script>. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Builds the srcdoc of the phone preview. The shared AppPanrom runtime (the same file bundled into APKs) renders
 * the IR. The iframe is sandboxed without same-origin, so app storage is bridged to the Studio via postMessage.
 */
export function buildPreviewDoc(ir: unknown, store: Record<string, string>, token: string): string {
  if (runtimeSource.includes('</script')) throw new Error('runtime must not contain </script');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{position:relative;height:100%}</style></head>
<body><div id="app"></div>
<script>${runtimeSource}</script>
<script>
(function () {
  var TOKEN = ${jsonForScript(token)};
  var data = ${jsonForScript(store)};
  function post(m) { m.token = TOKEN; parent.postMessage(m, '*'); }
  var storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); post({ type: 'ap-store', op: 'set', key: k, value: String(v) }); },
    removeItem: function (k) { delete data[k]; post({ type: 'ap-store', op: 'remove', key: k }); },
    keys: function () { return Object.keys(data); }
  };
  // The sandboxed iframe cannot reach the network or the device itself. Web requests go through the Studio's validated proxy;
  // location and notifications are asked of the browser by the Studio page (which shows the browser's own permission prompt).
  var pending = {}, nextId = 1;
  function ask(type, payload, done) {
    var id = nextId++;
    pending[id] = done;
    post({ type: type, id: id, req: payload });
  }
  function http(req, done) { ask('ap-http', req, done); }
  function location(done) { ask('ap-location', null, done); }
  function notify(title, text, done) { ask('ap-notify', { title: title, text: text }, done); }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.token !== TOKEN || m.type !== 'ap-reply' || !pending[m.id]) return;
    var cb = pending[m.id]; delete pending[m.id];
    cb(m.res);
  });
  var ir = ${jsonForScript(ir)};
  var ctrl = null;
  // Hot reload: the Studio sends freshly compiled code; the app keeps its state and only changed components are patched.
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.token !== TOKEN || m.type !== 'ap-update' || !ctrl) return;
    try { ctrl.hot(m.ir); } catch (err) { post({ type: 'ap-log', level: 'error', text: 'Hot reload failed: ' + (err && err.message) }); }
  });
  try {
    ctrl = AppPanrom.mount(ir, document.getElementById('app'), {
      namespace: 'preview',
      storage: storage,
      http: http,
      location: location,
      notify: notify,
      log: function (level, text) { post({ type: 'ap-log', level: level, text: text }); }
    });
    post({ type: 'ap-ready' });
  } catch (e) {
    post({ type: 'ap-log', level: 'error', text: 'Preview crashed: ' + (e && e.message) });
  }
})();
</script></body></html>`;
}
