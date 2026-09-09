# Study-room booking

The MCP supports the study rooms listed on [Waterloo LibCal](https://libcal.uwaterloo.ca/) at Davis Centre (`davis`), Dana Porter (`porter`), and Musagetes (`musagetes`). Availability is public. Checkout uses the saved Waterloo browser session and the normal LibCal/WatIAM sign-in redirect.

## Agent workflow

1. Call `list_study_rooms` to discover room IDs, names, libraries, and capacities.
2. Call `get_study_room_availability` with a local date and desired duration. Filter by library, room ID, or minimum capacity if useful.
3. Choose a room and time with the user. All times use `America/Toronto`; start times use 15-minute intervals.
4. Call `book_study_room` with the exact choice and a new UUID `bookingRequestId`.
5. Show the owner the returned approval URL. The page displays the room name, library, start, end, party size, and terms notice. Wait for the owner to approve.
6. Retry the exact tool arguments with `authorizationId`. Keep `bookingRequestId` unchanged.
7. Inspect the result. Only `status: confirmed` means the library’s confirmation was observed.

Example booking arguments:

```json
{
  "roomId": 12345,
  "date": "2026-09-10",
  "startTime": "13:00",
  "durationMinutes": 60,
  "partySize": 2,
  "bookingRequestId": "c0b25e30-31dc-43b9-855b-3156d4a19731"
}
```

Replace the example room ID with one returned by `list_study_rooms`, the date/time with the user’s choice, and the UUID with a new value for that intended booking. Do not copy the example blindly.

## Approval and limits

Availability reads do not create holds. LibCal checkout temporarily holds a selected slot, so checkout starts only after approval. The booking code rechecks the exact availability and signed end-time option before checkout. It does not substitute another room, date, or duration.

Approval includes acceptance of the library’s study-room terms and the normal confirmation email. The form must match the expected account and known acknowledgement question. A different account, unexpected form, new question, fee, or changed slot stops the operation.

The current [library guidelines](https://uwaterloo.ca/lib/services/study-rooms) permit booking up to one week ahead, for up to three hours, with at most three active bookings per week. Room capacity also applies. The library enforces account-wide quotas, including reservations made outside this MCP. Its current rules remain authoritative.

## Booking history and cancellation

`get_study_room_bookings` lists records created by this MCP only. It does not import reservations made manually, and it reports the last observed status rather than a live account-wide booking list.

`cancel_study_room_booking` takes a `bookingId` from that history and requires a separate owner approval. It uses only a cancellation link saved from the library’s confirmation. If no supported link was supplied, cancel manually through the confirmation email. The MCP does not accept arbitrary cancellation URLs or expose its saved cancellation links.

## Uncertain results

A network failure after submission can leave the outcome unknown. The service records its intent before submitting and returns `ROOM_BOOKING_UNKNOWN` if it cannot confirm the outcome. It blocks duplicate attempts for that request and that same room/time, including after a restart. Never change the UUID just to retry.

Check the library confirmation email and reservation details before taking further action. The server also keeps the checkout response, when received, in the encrypted booking record for owner recovery. Raw responses and cancellation links are excluded from MCP results. Do not delete booking history, replace the encryption key, or clear an active write lock to force a retry. The journal lives in `private/state/libcal/bookings.encrypted.json`; it belongs in private backups alongside the original session key.

A failed pre-submission attempt tries to release its temporary cart hold when the checkout session is known. An interrupted sign-in can leave a short hold until LibCal expires it. No final reservation is claimed without a recognized confirmation.

## Verification status

Live room discovery and availability have been checked for all three libraries. The existing saved Waterloo session reached the authenticated booking form. Local and isolated Linux Chromium tests cover successful form submission, a changed required question, and an uncertain response without making a real reservation. Approval, exact-argument matching, encrypted history, and duplicate protection have automated tests.

A real booking and cancellation have not yet been submitted for this release. They require the owner to choose a useful slot and approve each action. Cancellation support also depends on the confirmation page providing a recognized link.
