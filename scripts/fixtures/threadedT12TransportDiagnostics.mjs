import { createHash } from 'node:crypto';

/** Acceptance-only observation. It never records request/response bodies or headers. */
export function createT12TransportDiagnostics({ fetch, redact, now = Date.now }) {
  const records = [];
  const errorFact = error => {
    if (error === undefined || error === null) return null;
    const text = value => redact(String(value)).slice(0, 2000);
    return { name: text(error.name ?? typeof error), message: text(error.message ?? error),
      ...(error.code === undefined ? {} : { code: text(error.code) }),
      ...(error.cause ? { cause: { name: text(error.cause.name ?? typeof error.cause),
        message: text(error.cause.message ?? error.cause), ...(error.cause.code === undefined ? {} : { code: text(error.cause.code) }) } } : {}),
      ...(Array.isArray(error.errors) ? { errors: error.errors.slice(0, 8).map(value => ({ name: text(value.name ?? typeof value),
        message: text(value.message ?? value), ...(value.code === undefined ? {} : { code: text(value.code) }) })) } : {}) };
  };
  return { snapshot: () => structuredClone(records),
    async fetch(url, init) {
      const destination = new URL(url), startedAt = now(), bodyHash = createHash('sha256');
      const fact = { sequence: records.length + 1, method: init.method ?? 'GET', endpointHost: destination.hostname,
        pathname: destination.pathname, requestBytes: typeof init.body === 'string' ? Buffer.byteLength(init.body) : null,
        startedAt, state: 'awaiting_headers', bodyBytes: 0 };
      records.push(fact);
      const failed = (state, error) => Object.assign(fact, { state, finishedAt: now(), elapsedMs: now() - startedAt,
        error: errorFact(error), signalAborted: Boolean(init.signal?.aborted), signalReason: errorFact(init.signal?.reason) });
      let response;
      try { response = await fetch(url, init); }
      catch (error) { failed('fetch_error', error); throw error; }
      Object.assign(fact, { state: 'reading_body', headersAt: now(), status: response.status,
        contentType: response.headers.get('content-type'), declaredBodyBytes: Number(response.headers.get('content-length')) || null });
      if (!response.body) { Object.assign(fact, { state: 'body_complete', finishedAt: now(), elapsedMs: now() - startedAt,
        bodySha256: bodyHash.digest('hex') }); return response; }
      const reader = response.body.getReader();
      let cancelled = false;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (cancelled) return;
            if (part.done) { Object.assign(fact, { state: 'body_complete', finishedAt: now(), elapsedMs: now() - startedAt,
              bodySha256: bodyHash.digest('hex') }); controller.close(); }
            else { fact.bodyBytes += part.value.byteLength; bodyHash.update(part.value); controller.enqueue(part.value); }
          } catch (error) { if (!cancelled) { failed('body_error', error); controller.error(error); } }
        },
        async cancel(reason) { cancelled = true; failed('body_cancelled', reason); await reader.cancel(reason); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } };
}
