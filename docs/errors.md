# Error codes

Gateway errors include `code`, a safe `message`, an `action`, `retryable`, and a `requestId`. Share the code and request ID when reporting a failure. Raw upstream exceptions and authentication URLs are not returned to clients.

| Code                    | HTTP equivalent | Retry later | Meaning and next step                                                                                                 |
| ----------------------- | --------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_INVALID`        | 500             | No          | Service configuration is incomplete. Run npm run setup, then npm run doctor.                                          |
| `AUTH_REQUIRED`         | 401             | No          | Sign in to access this service. Open the service in your browser or supply an exe.dev client token.                   |
| `CLIENT_REVOKED`        | 403             | No          | This client is not allowed. Ask the owner to issue a new client token.                                                |
| `ORIGIN_REJECTED`       | 403             | No          | The request origin is not allowed. Use the configured HTTPS service URL.                                              |
| `INPUT_INVALID`         | 400             | No          | The request arguments are invalid. Check the tool input schema.                                                       |
| `REQUEST_TOO_LARGE`     | 413             | No          | The request is too large. Send a smaller request (maximum 64 KiB).                                                    |
| `TOOL_UNSUPPORTED`      | 403             | No          | This tool is not enabled. Refresh the tool list. Unreviewed tools are blocked.                                        |
| `APPROVAL_REQUIRED`     | 403             | No          | This action needs your approval. Open approvalUrl, review the action, then retry with authorizationId.                |
| `APPROVAL_INVALID`      | 403             | No          | Approval is missing, expired, used, or does not match. Request a new approval for the exact action.                   |
| `WRITE_PATH_REJECTED`   | 400             | No          | This download path is not allowed. Use /state/downloads and a filename without directories.                           |
| `AUTH_REAUTH_REQUIRED`  | 401             | No          | Your Waterloo session needs a new sign-in. Run npm run login on your computer, then deploy the updated private state. |
| `UPSTREAM_FORBIDDEN`    | 403             | No          | Waterloo denied access to this resource. Check whether your account can open the same item in LEARN.                  |
| `UPSTREAM_NOT_FOUND`    | 404             | No          | The course or item could not be found. Refresh the course content list and verify the item ID.                        |
| `UPSTREAM_RATE_LIMITED` | 429             | Yes         | Waterloo temporarily limited requests. Wait before retrying; do not repeatedly sign in.                               |
| `UPSTREAM_UNAVAILABLE`  | 502             | Yes         | The upstream service could not be reached. Retry once later. Use doctor if this persists.                             |
| `SERVICE_BUSY`          | 503             | Yes         | The service has too many requests in progress. Wait a few seconds and retry.                                          |
| `SERVICE_UNAVAILABLE`   | 503             | No          | The service could not start. Check the port, file permissions, and container status.                                  |
| `NOT_FOUND`             | 404             | No          | No such service route exists. Use /mcp for tools or / for setup help.                                                 |
| `INTERNAL_ERROR`        | 500             | No          | The request could not be completed. Share the error code and requestId, never credentials.                            |

For MCP tool errors, inspect `isError` and parse JSON from the text content. The enclosing HTTP response can be 200. Standard JSON-RPC validation errors and exe.dev proxy errors keep their own formats. Do not assume all network failures came from this gateway.

`retryable: true` permits a bounded later retry, not a tight loop. Login and approval errors require user action. Browser approval lasts 15 minutes and is consumed once, before a write starts.

Command-line diagnostics also use these codes:

| Code                         | Next step                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `SETUP_FAILED`               | Correct setup inputs. Existing keys are never overwritten.                                       |
| `CLIENT_BUSY`                | Another client command or its lock exists. Inspect before retrying.                              |
| `CLIENT_SETUP_FAILED`        | Check client name, configuration, signing key, and filesystem permissions.                       |
| `DEPLOY_FAILED`              | Check SSH, Docker, disk space, and any partially created installation.                           |
| `REMOTE_CHECK_FAILED`        | Check the private preview, service URL, token expiry, and VM client registry.                    |
| `AUTH_STATE_MOVED`           | Run renewal on the owning VM; do not use the stale local authenticator.                          |
| `MEDIA_TRANSCRIPTION_FAILED` | Check file type/size and time window; retry after one minute. This appears in job status output. |

`doctor` prints named checks with `ok`, `needs_action`, or `info` and exits nonzero when a required local check fails. It does not make network requests.
