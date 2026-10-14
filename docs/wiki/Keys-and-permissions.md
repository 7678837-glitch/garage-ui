# Keys and permissions

There are three distinct identities: a local UI user signs in to the console, an S3 access key reads or writes objects in Garage, and a Garage admin token authorizes administrative API calls. Changing one does not create or change the others.

## Create an S3 key

1. Open **Keys**, choose **Create**, enter **Key name**, and choose **Create key**.
2. Save the access key ID and secret in your application's secret store.
3. Grant access to the intended bucket before using the key.

Administrators can reveal the secret using **Show secret** in the list or **View secret** in the key's **Settings → Credentials** section. Review the confirmation, then use **Show secret** or **Copy secret** in the secret dialog. Choose **I have saved it** when finished. Closing the dialog removes that secret from the page. S3 key secrets can be requested again by an administrator; the one-time limitation for newly issued admin token secrets is different.

Use **Filter keys** and **Sort keys** to find loaded rows. Use **Load more** when more keys are available. A key detail has **Overview**, **Buckets**, and **Settings** tabs.

## Grant bucket access

1. Open the bucket's **Permissions** tab.
2. Select **Access key** and enable the required **Read**, **Write**, and **Owner** grants.
3. Choose **Grant** and wait for the success message.
4. Check the key's **Buckets** tab to see the resulting grants and aliases.

**Read** permits S3 reads; **Write** permits S3 writes. **Owner** is Garage's bucket ownership permission. These are Garage permissions, separate from a UI viewer's Download/Share flags. Use the smallest set your application requires.

Choose **Revoke** to remove the current owner/read/write permissions for that key on the bucket, then review and complete the confirmation. Clients using it may immediately lose access to the affected operations.

## Rename, enable bucket creation, or delete a key

In the key's **Settings → General**, change **Name** and choose **Save name**. In **Permissions**, toggle **Allow bucket creation**; this is saved automatically. It grants a Garage capability and does not grant UI administrator access.

In **Danger zone**, choose **Delete key** and confirm its ID. Clients using the key lose access. Deleting a key is not a rotation workflow that automatically updates those clients; issue a replacement and update consumers first if they still need access.

## Choose the key used for object operations

The UI server signs S3 operations; it does not send the Garage admin token to the browser. If an object page asks for **Bucket key**, an administrator chooses an eligible key and selects **Use this key**. The UI stores the key ID in its database and obtains its secret from Garage when needed.

A configured project-wide S3 key takes priority over the per-bucket selection. Ensure the selected or project key has the appropriate bucket grants. A read-only key can support reads but cannot upload or delete objects. UI administrator permission does not bypass Garage's S3 grant checks.

Viewer accounts cannot change the server's bucket-key binding. Ask an administrator to fix that binding if browsing or downloads fail for all viewers of a bucket. See [Configuration](Configuration.md#connect-object-operations).
