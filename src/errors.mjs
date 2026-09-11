import { randomUUID } from "node:crypto";

export const ERRORS = {
  HOST_REJECTED: [
    400,
    "The request hostname does not match this instance.",
    "Use this user's configured service URL; preserve Host in the HTTPS proxy.",
    false,
  ],
  LOGIN_RATE_LIMITED: [
    429,
    "Too many failed owner sign-ins.",
    "Wait one minute and check the private owner key file. Do not use your Waterloo password.",
    true,
  ],
  SESSION_IMPORT_REJECTED: [
    400,
    "The uploaded login could not be verified for this Waterloo account.",
    "Sign in to the configured account on your computer and retry. Never upload another user's session.",
    false,
  ],
  PIAZZA_AUTH_REQUIRED: [
    401,
    "Piazza needs a valid sign-in.",
    "Open /setup/piazza in the owner browser and verify your Piazza account. This can use a different password from Waterloo. Automatic renewal is limited after a failed login.",
    false,
  ],
  PIAZZA_STATE_INVALID: [
    500,
    "The encrypted Piazza login could not be read.",
    "Restore the matching state and session key, or reconnect Piazza through the owner setup page.",
    false,
  ],
  PIAZZA_FORBIDDEN: [
    403,
    "Piazza denied access to this class or post.",
    "Check that your Piazza account belongs to the class and can open this post.",
    false,
  ],
  PIAZZA_NOT_FOUND: [
    404,
    "The Piazza class or post was not found.",
    "Refresh your Piazza class list and verify the post ID.",
    false,
  ],
  PIAZZA_RESPONSE_CHANGED: [
    502,
    "The Piazza response was not recognized.",
    "Report this code and the operation. Do not repeatedly sign in or guess alternate API methods.",
    false,
  ],
  ROOM_NOT_FOUND: [
    404,
    "The study room was not found.",
    "Refresh list_study_rooms and use its room ID.",
    false,
  ],
  ROOM_UNAVAILABLE: [
    409,
    "The exact room and time are no longer available.",
    "Search availability again. A different room or time needs a new approval.",
    false,
  ],
  ROOM_POLICY_LIMIT: [
    400,
    "This request exceeds a room or booking limit.",
    "Use a future time within one week, 15–180 minutes in 15-minute steps, and respect room capacity and the library booking quota.",
    false,
  ],
  ROOM_AUTH_REQUIRED: [
    401,
    "LibCal needs a current Waterloo sign-in.",
    "Run check_auth to renew Waterloo, then retry after a new approval. If it persists, refresh the saved browser login. A temporary checkout hold may take a few minutes to expire.",
    false,
  ],
  ROOM_PAGE_CHANGED: [
    502,
    "The LibCal response or booking form was not recognized.",
    "Stop and report this code. Do not guess form fields or submit repeatedly.",
    false,
  ],
  ROOM_BOOKING_UNKNOWN: [
    409,
    "A booking or cancellation may have been submitted, but its outcome is unconfirmed.",
    "Check get_study_room_bookings and your library confirmation email. Do not create a new request ID or repeat the action until the outcome is known.",
    false,
  ],
  ROOM_REQUEST_CONFLICT: [
    409,
    "This booking request conflicts with a recorded attempt.",
    "Reuse the original bookingRequestId only with identical arguments; inspect existing booking records before starting another attempt.",
    false,
  ],
  ROOM_BOOKING_NOT_FOUND: [
    404,
    "This MCP has no record of that booking.",
    "Use a bookingId from get_study_room_bookings. Manual bookings are not imported.",
    false,
  ],
  ROOM_CANCEL_UNAVAILABLE: [
    409,
    "This booking cannot be cancelled through the stored receipt.",
    "Use the cancellation instructions in your library confirmation email.",
    false,
  ],
  ROOM_STATE_INVALID: [
    500,
    "The encrypted booking history could not be read.",
    "Restore the original state and encryption key. Do not replace history or retry uncertain bookings.",
    false,
  ],
  CONFIG_INVALID: [
    500,
    "Service configuration is incomplete.",
    "Run npm run setup, then npm run doctor.",
    false,
  ],
  AUTH_REQUIRED: [
    401,
    "Sign in to access this service.",
    "Open the owner sign-in page, or use the agent token and authentication header configured for this instance.",
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
    "Send a smaller request: 64 KiB for normal requests, or 1 MiB for a browser-session import.",
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
    "Refresh the login for this user. For a portable host, use the remote login command in docs/hosting.md; legacy deployments require a secure state update.",
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
