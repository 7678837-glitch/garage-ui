# Audit

Only administrators can view and export UI audit records. These records are stored in the UI database; they are not a complete replacement for Garage or reverse-proxy logs.

## Find an event

1. Open **Audit**.
2. Open **Filters**, then enter **User**, **From**, **To**, and/or **Target** as needed. Changes apply immediately and return the list to its first page.
3. Read the result, reason, method, path, target, and status alongside the username and IP address.
4. Use pagination for additional records; the UI requests 100 records per page. Filtering and pagination run in SQLite, with one extra row fetched to determine whether another page exists.

**From** and **To** inputs are in **UTC**, even though the browser uses a date/time input without a timezone suffix. For example, enter `2026-10-14 08:00:00` to mean 08:00 UTC. Invalid dates show **Enter a valid UTC date and time** and stop filtering/export until corrected.

Displayed timestamps use the UI's readable timestamp presentation; inspect the exact timestamp when comparing events with other systems. Do not infer your local timezone for the UTC filter fields.

The **User** filter is an exact username match. The **Target** filter is an exact match for the event's **target** field; copy a target value from a record when using it. The API query parameter remains `action` for this target filter.

The **Filters** heading shows a count when any fields are nonempty. Clear each field to reset filtering. Collapsing **Filters** preserves their values and count; **Export audit** remains available in the page header.

Rejected upstream mutations are recorded as errors. A Garage response with per-node errors is also recorded as an error, even when Garage returns HTTP 200; the status column retains that upstream status. Read the result and reason together with the status. Raw upstream error details are not copied into audit records. A successful maintenance request still needs operational follow-up in Garage.

## Export filtered records

Apply the desired filters and choose **Export audit**. The browser downloads `audit.csv`. The export uses the filters, rather than just copying the visible table page. The page first sends a `HEAD` request to check access and filters, then starts a native browser download from the export URL. It does not buffer the CSV into a page-created blob. Treat the file as operational data: it can contain usernames, IP addresses, paths, and targets.

The server reads filtered records in batches of 128 and streams CSV frames of at most 64 KiB. Each export captures the highest audit ID when it starts, so newly created events do not extend that export. Closing the download drops its pending database read; no background export task continues.

If **Export failed** appears, the preflight or download initiation failed; verify your session and filters, then retry. Failures during the subsequent `GET` download are managed by the browser: inspect its download status, because the page cannot report those failures. Preserve the UI database when upgrading if you need to retain the audit history.

Formula-leading text cells, including `=`, `+`, `-`, `@` and their full-width forms after leading whitespace/control characters, receive a leading single quote in the CSV. Leading tab, carriage-return, or newline cells are escaped too. Stored audit text and the JSON list remain unchanged. For example, a stored target `=1+1` exports as `'=1+1`. Import CSV columns as text when inspecting untrusted values; spreadsheet applications can alter quoting when saving or reopening the file, so this export does not guarantee safety after those transformations.
