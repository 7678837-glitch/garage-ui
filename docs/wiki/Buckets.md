# Buckets

A bucket stores objects in Garage. Its ID is the stable identifier; aliases provide names for clients. Administrators can change buckets. Viewers can inspect accessible bucket information.

## Create and find a bucket

1. Open **Buckets** and choose **Create**.
2. Enter the global alias and choose **Create bucket**.
3. Wait for **Bucket created**, then open the bucket name.

The detail view contains **Overview**, **Objects**, **Permissions**, and **Settings** tabs. **Overview** shows identity, aliases, and usage. **Objects** opens the object browser; **Permissions** manages grants; **Settings** contains aliases, quotas, CORS, lifecycle, incomplete uploads, and deletion.

Use **Filter buckets** to find an ID or alias. Sorting offers ID, alias, and creation order. Filtering and sorting concern loaded rows; use **Load more** when more buckets are available. An empty filtered list does not prove the cluster has no matching bucket.

## Add or remove aliases

In the bucket's **Settings**, open **Aliases** and choose a global or local alias. A global alias names the bucket cluster-wide. A local alias is tied to the selected access key; supply that key as well as the alias. Choose **Add alias** and wait for **Alias added**.

Use the corresponding **Remove global alias** or **Remove local alias** action to remove a name. Removing an alias changes how clients address the bucket; it does not delete its objects.

## Set quotas

In **Settings → Quotas**, enter **Max size** as a whole number of bytes and **Max objects** as a whole object count. Leave a field empty to unset that quota. Choose **Save quotas** and wait for **Saved**. The usage view shows limits and current usage when Garage supplies them.

For example, a size quota of `1073741824` is 1 GiB. A quota constrains storage; it does not grant anyone permission to use it. If saving fails, retain the error message and check that values are whole numbers and that Garage accepts the requested update.

## Configure CORS

Use this when a browser application on another origin needs to call Garage S3 directly.

1. Choose **Edit CORS**, then **Add CORS rule**.
2. Enter a rule **ID**, at least one **AllowedOrigin**, and at least one **AllowedMethod**. Add **AllowedHeader**, **ExposeHeader**, and **MaxAgeSeconds** as needed. The editor requires a nonempty ID. List fields use comma-separated values.
3. Choose **Review CORS** to compare **Current** and **Next** rules.
4. Choose **Save CORS** after reviewing the replacement.

For a browser app at `https://files.example.org`, an origin entry can be that exact origin and a method entry can be `GET, HEAD`. Use origins and methods required by your own application. CORS controls browser cross-origin requests; it is not a substitute for S3 key permissions. Removing a rule is staged until you review and save.

## Configure lifecycle rules

Lifecycle changes can expire objects. Review the prefix and expiration carefully before saving.

1. Choose **Edit lifecycle** and **Add lifecycle rule**.
2. Set a nonempty **ID**, **Status** (`Enabled` or `Disabled`), and optional **Filter.Prefix**, **Filter.ObjectSizeGreaterThan**, or **Filter.ObjectSizeLessThan**.
3. Set an expiration using **Expiration.Days** or **Expiration.Date**, and/or **AbortIncompleteMultipartUpload.DaysAfterInitiation**. Do not set both expiration days and a date. Numeric fields accept whole nonnegative numbers; when both object-size bounds are set, the lower bound must be smaller than the upper bound.
4. Choose **Review lifecycle**, inspect **Current** and **Next**, then **Save lifecycle**.

For example, use a prefix such as `temporary/` to target only temporary objects, rather than leaving the filter empty. Execution of lifecycle policy belongs to Garage; saving a rule is not evidence that objects have already expired. Fields not represented by the editor are preserved when possible; review the resulting rules before replacing them.

## Clean up incomplete uploads

Open **Incomplete uploads** in **Settings** to inspect object keys, upload IDs, and initiation times. Enter a whole age in **Older than hours**, then choose **Clean up**. The UI refreshes the list and reports **Cleaned up** with the count Garage returns.

Choose an age greater than the time legitimate uploads may need. Cleanup aborts old incomplete uploads, so clients cannot finish those uploads afterward. The browser provides age-based cleanup; use Garage's S3 tooling if you need to abort one particular upload ID.

## Delete an empty bucket

Open **Settings → Danger zone** and choose the bucket deletion action. Review the ID and consequences, and enter the requested confirmation. Garage rejects deletion while objects remain. Deleting a bucket also removes its aliases. To empty a prefix, see [Objects](Objects.md#delete-objects-or-a-prefix).
