import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface UnixHttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface UnixHttpRequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Node-compatible HTTP over a filesystem Unix socket (works across Bun processes). */
export function requestUnixHttp(
  socketPath: string,
  path: string,
  options: UnixHttpRequestOptions = {},
): Promise<UnixHttpResponse> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const clearRequestTimeout = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
    };
    const request = httpRequest(
      {
        socketPath,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          bytes += buffer.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Catalogue service response exceeded 4 MiB."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          clearRequestTimeout();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        request.destroy(new Error("Catalogue service request timed out."));
      }, timeoutMs);
    }
    request.on("error", (cause) => {
      clearRequestTimeout();
      reject(cause);
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}
