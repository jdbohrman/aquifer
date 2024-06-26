import { AnyEvent, FunctionLogger, FetchOpts, FetchResponse } from "@jitsu/protocols/functions";

export type JsonFetchOpts = Omit<FetchOpts, "body"> & {
  body?: any;
};

export type JsonFetcher = (url: string, options?: JsonFetchOpts, debug?: { event?: AnyEvent }) => Promise<any>;

const maxResponseLen = 300;

function prettifyJson(bodyStr: any) {
  if (!bodyStr) {
    return bodyStr + "";
  } else if (typeof bodyStr === "string") {
    try {
      return JSON.stringify(JSON.parse(bodyStr), null, 2);
    } catch (e) {
      return bodyStr + "";
    }
  } else {
    try {
      return JSON.stringify(bodyStr, null, 2);
    } catch (e) {
      return bodyStr + "";
    }
  }
}

export class JsonFetchError extends Error {
  public readonly responseStatus: number;
  constructor(responseStatus: number, errorMessage: any) {
    super(errorMessage);
    this.responseStatus = responseStatus;
  }
}

export function jsonFetcher(
  fetch: (url: string, opts?: FetchOpts, debug?: { event?: AnyEvent }) => Promise<FetchResponse>,
  { log, debug }: { log: FunctionLogger; debug?: boolean } = { log: console }
): JsonFetcher {
  return async (url: string, options?: JsonFetchOpts) => {
    const method = options?.method || (options?.body ? "POST" : "GET");
    const bodyStr =
      typeof options?.body === "string" ? options?.body : options?.body ? JSON.stringify(options?.body) : undefined;
    const response = await fetch(url, {
      ...(options || {}),
      headers: {
        ...(options?.headers || {}),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      method,
      body: bodyStr,
    });
    let responseText = await response.text();
    if (debug) {
      const message = `${method} ${url} → ${response.ok ? "🟢" : "🔴"}${response.status} ${
        response.statusText
      }.\n📩Response body${responseText ? `: \n${prettifyJson(responseText)}` : " is empty"}`;
      if (response.ok) {
        log.debug(message);
      } else {
        log.warn(message);
      }
    }
    if (!response.ok) {
      if (responseText.length > maxResponseLen) {
        responseText =
          responseText.substring(0, maxResponseLen) + "...(truncated, total length: " + responseText.length + ")";
      }
      throw new JsonFetchError(
        response.status,
        `${method} ${url} failed with status ${response.status} ${response.statusText}: ${responseText}`
      );
    }
    if (responseText === "") {
      return undefined;
    } else {
      try {
        return JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Request error: ${method} ${url} returned unparseable JSON: ${responseText}`);
      }
    }
  };
}
