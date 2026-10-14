# Objects

Open **Buckets**, select a bucket, and choose **Objects**. Objects live in Garage; the browser shows their keys as a folder-like hierarchy based on `/` prefixes. A folder is a key prefix, not a separate storage container.

## Browse and search

Choose a prefix row to enter it. Use **Root** or the breadcrumb buttons to return to a parent prefix. **Back to buckets** returns to the list. Use **Next page** when the current response has more entries.

Enter a search term of at least two characters in **Search** and submit the search form to search within the current prefix. Submit an empty search to return to browsing. Search is a case-sensitive substring match on object keys and stops at 200 matches or 20 S3 listing pages; read any truncation notice and narrow the prefix or term rather than treating the result as exhaustive.

**Size** and **Time** sorting apply only to the loaded page, as the **Only this page** notice states. Prefix rows stay ahead of objects. The list does not globally sort every object in the bucket.

Select individual checkboxes or **Select page**. Selection actions use the objects selected on the displayed page. **Clear selection** clears the checked objects. **Copy path** copies selected keys; if clipboard access is unavailable, the UI displays selectable paths for manual copying.

## Upload files or a folder

Administrators can upload. Choose **Upload** to open the panel. **Close upload** hides it while retaining the current queue; choose **Upload** again to reopen it. In the upload panel:

1. Use **Choose files**, **Choose folder**, or drop files into the panel.
2. Watch each row move from **Queued** through **Checking destination** and **Uploading** to **Done**.
3. If the destination already exists, choose **Overwrite**, **Skip**, or **Overwrite all**. **Overwrite all** approves queued entries with the same key; it is not blanket approval for every different existing filename.
4. After **Done**, the object list refreshes.

Individual files use their filenames as keys. Folder selection retains the selected folder's relative path. Upload keys are not automatically prefixed with the folder currently being browsed. Check the queue's destination names before overwriting.

The browser processes up to three checking/uploading rows at once. Uploads over 64 MiB use multipart upload with 16 MiB parts on the server. The default individual-file limit is 512 MiB, controlled by `MAX_UPLOAD_SIZE_MB`.

Choose **Cancel** to stop a queued, checking, or uploading row. Use **Retry** for a failed or cancelled row. **Clear finished** removes completed, failed, and cancelled rows from the displayed queue. It does not remove stored objects.

Keep the page open until uploads finish. Leaving after the unfinished-upload warning cancels active work; the queue is not a persistent background-upload service. Use [bucket cleanup](Buckets.md#clean-up-incomplete-uploads) for abandoned multipart uploads.

## Inspect an object

Choose an object filename to preview its key, size, content type, ETag, and last-modified time. For administrators, **Details** opens exact size, last-modified time, and Garage object versions. It does not restore a previous version.

For content previews and transfers, see [Downloads and sharing](Downloads-and-sharing.md).

## Delete objects or a prefix

Deletion requires an administrator and explicit confirmation.

- For one object, select it and choose **Delete**. Confirm the exact key requested by the dialog.
- For several objects, select their checkboxes and choose **Delete**. Review the counted selection and total bytes, then complete the confirmation.
- For a prefix row, open **Actions → Delete folder**. Confirm the prefix. This recursively deletes every object whose key starts with that prefix, including objects outside the loaded page.

A partial failure can leave some objects deleted and others present. Read the per-key errors, let the refreshed list show the remaining state, and retry only after resolving the cause. Deletion is not an undoable move to a trash folder.

If **Bucket key** appears or the list is unavailable, see [Keys and permissions](Keys-and-permissions.md#choose-the-key-used-for-object-operations) and [Troubleshooting](Troubleshooting.md).
