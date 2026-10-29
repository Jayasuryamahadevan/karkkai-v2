export class ApiError extends Error {
  constructor(message, status = 0, detail = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function withTimeout(ms, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function parseError(response) {
  let detail = "";
  try {
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || data.error || "";
    } else {
      detail = (await response.text()).slice(0, 260);
    }
  } catch {
    detail = "";
  }
  const message = typeof detail === "string" && detail.trim()
    ? detail.trim()
    : `Request failed (${response.status})`;
  return new ApiError(message, response.status, message);
}

export async function request(path, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    timeout = 40000,
    signal,
  } = options;
  const timer = withTimeout(timeout, signal);
  try {
    const response = await fetch(path, {
      method,
      body,
      headers,
      signal: timer.signal,
      credentials: "same-origin",
    });
    if (!response.ok) throw await parseError(response);
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      if (signal?.aborted) throw new ApiError("Cancelled", 0, "Cancelled");
      throw new ApiError("The server took too long to answer. Please try again.", 0, "Timeout");
    }
    throw new ApiError("Could not reach the local Chillian server.", 0, String(error?.message || error));
  } finally {
    timer.clear();
  }
}

export const api = {
  async json(path, options = {}) {
    const response = await request(path, options);
    return response.json();
  },

  get(path, params = {}, options = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
    return api.json(url.pathname + url.search, options);
  },

  post(path, data, options = {}) {
    return api.json(path, {
      ...options,
      method: "POST",
      body: JSON.stringify(data),
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  },

  async form(path, formData, options = {}) {
    const response = await request(path, { ...options, method: "POST", body: formData });
    return response.json();
  },

  async blob(path, data, options = {}) {
    const init = { ...options, method: "POST" };
    if (data instanceof FormData) {
      init.body = data;
    } else if (data !== undefined && data !== null) {
      init.body = JSON.stringify(data);
      init.headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    }
    const response = await request(path, init);
    const blob = await response.blob();
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { blob, headers, status: response.status };
  },

  async delete(path) {
    const response = await request(path, { method: "DELETE" });
    return response.json();
  },
};

export function errorMessage(error) {
  if (!error) return "Something went wrong.";
  if (error instanceof ApiError) return error.message;
  return String(error.message || error);
}
