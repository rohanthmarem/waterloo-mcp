import { randomUUID } from "node:crypto";

export const ERRORS = {
  CONFIG_INVALID: [
    500,
    "Service configuration is incomplete.",
    "Run npm run setup, then npm run doctor.",
    false,
  ],
  AUTH_REQUIRED: [
    401,
    "Sign in to access this service.",
    "Open the service in your browser or supply an exe.dev client token.",
    false,
  ],
  CLIENT_REVOKED: [
    403,
    "This client is not allowed.",
    "Ask the owner to issue a new client token.",
    false,
  ],
  ORIGIN_REJECTED: [
    403,
    "The request origin is not allowed.",
    "Use the configured HTTPS service URL.",
    false,
  ],
  INPUT_INVALID: [
    400,
    "The request arguments are invalid.",
    "Check the tool input schema.",
    false,
  ],
  REQUEST_TOO_LARGE: [
    413,
    "The request is too large.",
    "Send a smaller request (maximum 64 KiB).",
    false,
  ],
  TOOL_UNSUPPORTED: [
    403,
    "This tool is not enabled.",
    "Refresh the tool list. Unreviewed tools are blocked.",
    false,
  ],
  APPROVAL_REQUIRED: [
    403,
    "This action needs your approval.",
    "Open approvalUrl, review the action, then retry with authorizationId.",
    false,
  ],
  APPROVAL_INVALID: [
    403,
    "Approval is missing, expired, used, or does not match.",
    "Request a new approval for the exact action.",
    false,
  ],
  WRITE_PATH_REJECTED: [
    400,
    "This download path is not allowed.",
    "Use /state/downloads and a filename without directories.",
    false,
  ],
  AUTH_REAUTH_REQUIRED: [
    401,
    "Your Waterloo session needs a new sign-in.",
    "Run npm run login on your computer, then deploy the updated private state.",
    false,
  ],
  UPSTREAM_FORBIDDEN: [
    403,
    "Waterloo denied access to this resource.",
    "Check whether your account can open the same item in LEARN.",
    false,
  ],
  UPSTREAM_NOT_FOUND: [
    404,
    "The course or item could not be found.",
    "Refresh the course content list and verify the item ID.",
    false,
  ],
  UPSTREAM_RATE_LIMITED: [
    429,
    "Waterloo temporarily limited requests.",
    "Wait before retrying; do not repeatedly sign in.",
    true,
  ],
  UPSTREAM_UNAVAILABLE: [
    502,
    "The upstream service could not be reached.",
    "Retry once later. Use doctor if this persists.",
    true,
  ],
  SERVICE_BUSY: [
    503,
    "The service has too many requests in progress.",
    "Wait a few seconds and retry.",
    true,
  ],
  SERVICE_UNAVAILABLE: [
    503,
    "The service could not start.",
    "Check the port, file permissions, and container status.",
    false,
  ],
  NOT_FOUND: [
    404,
    "No such service route exists.",
    "Use /mcp for tools or / for setup help.",
    false,
  ],
  INTERNAL_ERROR: [
    500,
    "The request could not be completed.",
    "Share the error code and requestId, never credentials.",
    false,
  ],
};

export function problem(code, extra = {}) {
  const [httpStatus, message, action, retryable] =
    ERRORS[code] ?? ERRORS.INTERNAL_ERROR;
  return {
    error: {
      code: ERRORS[code] ? code : "INTERNAL_ERROR",
      message,
      action,
      retryable,
      requestId: randomUUID(),
      ...extra,
    },
    httpStatus,
  };
}
export function toolError(code, extra = {}) {
  const p = problem(code, extra);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(p) }],
  };
}
export function normalizeToolResult(result) {
  if (!result?.isError) return result;
  const text =
    result.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ") ?? "";
  try {
    const parsed = JSON.parse(text);
    if (ERRORS[parsed?.error?.code]) return result;
  } catch {}
  const patterns = [
    [/invalid input|validation|arguments/i, "INPUT_INVALID"],
    [/auth|sign.in|credential|session|renewal/i, "AUTH_REAUTH_REQUIRED"],
    [/access denied|permission|forbidden/i, "UPSTREAM_FORBIDDEN"],
    [/not found|may not exist/i, "UPSTREAM_NOT_FOUND"],
    [/rate limit/i, "UPSTREAM_RATE_LIMITED"],
  ];
  return toolError(
    patterns.find(([pattern]) => pattern.test(text))?.[1] ??
      "UPSTREAM_UNAVAILABLE",
  );
}
