# Audit

Only administrators can view and export UI audit records. These records are stored in the UI database; they are not a complete replacement for Garage or reverse-proxy logs.

## Find an event

1. Open **Audit**.
2. Enter **User**, **Action**, **From**, and/or **To** filters as needed.
3. Read the result, reason, method, path, target, and status alongside the username and IP address.
4. Use pagination for additional records; the UI requests 100 records per page.

**From** and **To** inputs are in **UTC**, even though the browser uses a date/time input without a timezone suffix. For example, enter `2026-10-14 08:00:00` to mean 08:00 UTC. Invalid dates show **Enter a valid UTC date and time** and stop filtering/export until corrected.

Displayed timestamps use the UI's readable timestamp presentation; inspect the exact timestamp when comparing events with other systems. Do not infer your local timezone for the UTC filter fields.

The **User** filter is an exact username match. Despite its **Action** label, the current **Action** filter exact-matches the event's **target** field, not its reason or HTTP method. Copy the target value from a record when using that filter. A failed or denied event explains the UI request outcome; a successful maintenance request still needs operational follow-up in Garage.

## Export filtered records

Apply the desired filters and choose **Export audit**. The browser downloads `audit.csv`. The export uses the filters, rather than just copying the visible table page. Treat the file as operational data: it can contain usernames, IP addresses, paths, and targets.

If **Export failed** appears, verify your session and filters, then retry. Preserve the UI database when upgrading if you need to retain the audit history.
