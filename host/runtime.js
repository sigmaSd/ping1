/**
 * denoapk runtime shim — injected by the host, never imported by app code.
 *
 * App code writes ordinary Deno-style fetch:
 *
 *   fetch("https://claude.ai/api/organizations", { headers: { Cookie: ... } })
 *
 * A WebView would drop `Cookie`, `User-Agent`, `Referer` and `Sec-Fetch-*`
 * (forbidden request headers) and then fail the CORS check anyway. So this
 * shim rewrites cross-origin requests to a host-served proxy path, carrying
 * the headers under an `x-denoapk-h-` prefix that the browser will send
 * happily. The host strips the prefix and performs the real request.
 *
 * This runs *before* fetch, while `init.headers` is still an ordinary object,
 * which is why the forbidden names are still intact at this point.
 *
 * Unlike fetch, there's no browser-standard "run a subprocess" API to
 * transparently patch — denoapk.exec()/denoapk.execStream() below are new
 * API surfaces apps explicitly opt into, not an invisible shim. They run
 * whatever binary + args they're given, with no allowlist; see denoapk's
 * ExecClient.java (exec) and ExecStreamBridge.java (execStream) for that
 * trust boundary in full.
 *
 * denoapk.execStream()'s transport genuinely differs by platform, unlike
 * everything else in this file. fetch()-based streaming (a chunked response
 * body, `/__denoapk/exec-stream/`) works fine on a real Deno host, but
 * verified on-device that it does NOT work through Android's WebView:
 * shouldInterceptRequest's WebResourceResponse reads its InputStream to EOF
 * internally before the page's fetch() sees anything, so an unbounded
 * process would never deliver a byte. Android instead uses
 * DenoapkExecStreamBridge, an addJavascriptInterface object the shell
 * registers that pushes each chunk to the page via evaluateJavascript() —
 * genuine native-to-page push, so there's no "buffer until EOF" to get stuck
 * on. The public denoapk.execStream() API is identical either way; only the
 * wire mechanism underneath picks itself based on which transport exists.
 *
 * The same file is served by the Deno host (e.g. report.ts) and baked into
 * the APK, so both platforms agree on the wire format for everything else.
 */
(function () {
  const PROXY = "/__denoapk/proxy/";
  const EXEC = "/__denoapk/exec/";
  const EXEC_STREAM = "/__denoapk/exec-stream/";
  const PREFIX = "x-denoapk-h-";
  const orig = globalThis.fetch;

  globalThis.fetch = function (input, init = {}) {
    const href = typeof input === "string" ? input : input.url;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return orig(input, init);
    }
    if (url.origin === location.origin) return orig(input, init);

    // `new Headers()` has guard "none", so forbidden names survive the copy.
    const encoded = {};
    new Headers(init.headers || {}).forEach((value, name) => {
      encoded[PREFIX + name] = value;
    });

    // Encoded so the target URL can never be confused with the proxy path.
    return orig(PROXY + encodeURIComponent(url.href), {
      ...init,
      headers: encoded,
    });
  };

  // Same-origin by construction, so this never touches the fetch override
  // above — it goes straight to the host, native on Android or Deno.Command
  // on desktop (see that host's own /__denoapk/exec/ route).
  globalThis.denoapk = globalThis.denoapk || {};
  globalThis.denoapk.exec = function (cmd, args, opts) {
    const body = { cmd, args: args || [] };
    if (opts && opts.timeoutMs) body.timeoutMs = opts.timeoutMs;
    return orig(EXEC + encodeURIComponent(JSON.stringify(body)))
      .then((r) => r.json());
  };

  // Long-running/unbounded command (e.g. `ping` with no -c): streams the
  // process's merged stdout+stderr as text chunks instead of waiting for it
  // to finish. Runs until the process ends on its own or .cancel() is
  // called — there's no timeout, unlike denoapk.exec().
  //
  //   const stream = denoapk.execStream("/system/bin/ping", [host]);
  //   for await (const chunk of stream) { ... }
  //   stream.cancel(); // kills the underlying process
  globalThis.denoapk.execStream = globalThis.DenoapkExecStreamBridge
    ? execStreamViaBridge
    : execStreamViaFetch;

  // Android: push-based, via ExecStreamBridge.java. The bridge calls
  // window.__denoapkExecStreamPush(id, chunk, done) as output arrives; this
  // queue bridges that push-based delivery into the pull-based
  // for-await-of consumers expect (a push can arrive before anyone's
  // waiting for it, or a consumer can be waiting before anything's pushed —
  // both need to work).
  const execStreamQueues = new Map(); // id -> { queue: [{chunk,done}], resolve: fn|null }
  globalThis.__denoapkExecStreamPush = function (id, chunk, done) {
    const s = execStreamQueues.get(id);
    if (!s) return; // already cancelled/consumed to completion
    const item = { chunk, done };
    if (s.resolve) {
      const resolve = s.resolve;
      s.resolve = null;
      resolve(item);
    } else {
      s.queue.push(item);
    }
  };

  function execStreamViaBridge(cmd, args) {
    const id = globalThis.DenoapkExecStreamBridge.start(
      JSON.stringify({ cmd, args: args || [] }),
    );
    if (!id) {
      return {
        cancel() {},
        [Symbol.asyncIterator]() {
          throw new Error("execStream: failed to start " + cmd);
        },
      };
    }
    execStreamQueues.set(id, { queue: [], resolve: null });

    return {
      cancel() {
        globalThis.DenoapkExecStreamBridge.cancel(id);
        execStreamQueues.delete(id);
      },
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const s = execStreamQueues.get(id);
            if (!s) return; // cancelled
            const item = s.queue.length > 0
              ? s.queue.shift()
              : await new Promise((resolve) => {
                s.resolve = resolve;
              });
            if (item.done) return;
            yield item.chunk;
          }
        } finally {
          execStreamQueues.delete(id);
        }
      },
    };
  }

  // Desktop: fetch()-based streaming works here, unlike on Android's WebView
  // — a real Deno HTTP server streams a chunked Response body without
  // buffering it first.
  function execStreamViaFetch(cmd, args) {
    const body = { cmd, args: args || [] };
    const controller = new AbortController();
    const responsePromise = orig(
      EXEC_STREAM + encodeURIComponent(JSON.stringify(body)),
      { signal: controller.signal },
    );

    return {
      cancel() {
        controller.abort();
      },
      async *[Symbol.asyncIterator]() {
        const res = await responsePromise;
        if (!res.ok) {
          throw new Error("execStream failed: " + res.status);
        }
        const reader = res.body.pipeThrough(new TextDecoderStream())
          .getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  // Hosts may append a `__DENOAPK_ENV` assignment after this file; default it
  // so app code can read it unconditionally.
  globalThis.__DENOAPK_ENV = globalThis.__DENOAPK_ENV || {};
})();
