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
  var ir = ${jsonForScript(ir)};
  try {
    AppPanrom.mount(ir, document.getElementById('app'), {
      namespace: 'preview',
      storage: storage,
      log: function (level, text) { post({ type: 'ap-log', level: level, text: text }); }
    });
    post({ type: 'ap-ready' });
  } catch (e) {
    post({ type: 'ap-log', level: 'error', text: 'Preview crashed: ' + (e && e.message) });
  }
})();
</script></body></html>`;
}
