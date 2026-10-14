# Admin tokens

Garage admin tokens authorize the Garage administrative API. Only UI administrators can manage them. They are distinct from S3 access keys and UI login sessions.

## Check the token used by this server

Open **Admin tokens** and inspect **This server**. The panel shows the current token's name, scope, expiration, expired status, and whether it comes from a configuration file. A token that lacks an endpoint's scope can cause that operation to fail even for a UI administrator.

## Create a scoped token

1. Choose **Create token**.
2. Enter **Name** and **Expiration**, or deliberately select **Never expires**.
3. Choose only the endpoint scopes needed by the consumer. Groups cover Cluster, Node, Layout, Bucket, Key, Permission, Worker, Block, and Admin token operations.
4. Review the confirmation and choose **Create token**.
5. In **Admin token secret**, choose **Show secret** or **Copy secret**, store it securely, then choose **I have saved it**.

The newly issued secret is available once. Closing the dialog removes it from the page, and it cannot be retrieved later. If it is lost, create a replacement token and revoke the unusable one.

Use **Filter scope** to match group names or endpoint names without regard to case. Scroll within the compact scope list to reach more endpoints. The selected count includes scopes hidden by the filter; filtering does not clear selections. A group checkbox selects or clears the complete group, and **All** selects or clears every endpoint, regardless of the filter.

Choosing **All** or every endpoint produces full administrative access and displays a warning. Token-management endpoints can themselves confer powerful access; choose them only when the consumer needs to administer tokens.

## Update or delete a token

Find the token using **Filter admin tokens** and **Sort**. Filtering and sorting apply to the current page; use **Previous** and **Next** for additional pages.

Open its **Actions** and choose **Edit**. The editor brings **Name** into view and focuses it. Change name, expiration, and scope, then choose **Update token** and review the replacement confirmation. This updates those fields; it does not display a new secret. Choose **Cancel** to close the editor and return focus to that token's **Edit** action.

Use **Actions → Delete** and confirm to revoke a token. Before removing or restricting the token used by this UI server, provision its replacement and update the server's configuration. Otherwise later Garage admin operations can fail. Configuration-sourced tokens are identified in the list; Garage determines which token mutations are allowed.
