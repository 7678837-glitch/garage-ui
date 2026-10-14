# Downloads and sharing

Administrators can read and share object content. Viewers need **Download** for content reads; sharing additionally requires **Share**. Browsing keys and metadata does not by itself grant content access.

## Preview content

Select one object. The details panel can preview PNG, JPEG, GIF, WebP, AVIF, BMP, icon images, plain text, PDF, MP4/WebM video, and MPEG/Ogg/WAV audio when its content type matches the allowed types. Browser support still determines whether a media format plays.

Plain-text previews show at most the first **256 KiB** and display a notice when truncated. HTML, SVG, XML, JavaScript, and other unapproved types are served as attachments rather than active inline content. A file extension alone does not determine the preview type.

When focus is in the preview area, use Left or Right to move between objects in the loaded directory. Bitmap thumbnails in the object list also require download permission. An unsupported preview does not prevent downloading the original file when permitted.

## Download one object

Select one object and choose **Download**. The server reads the object from Garage and sends it to the authenticated browser. Confirm that the downloaded filename and size match the intended object.

## Download several objects as a ZIP

Select more than one object and choose **Download ZIP**. After the UI prepares the download link, follow that link to stream the archive. The selection applies to the displayed objects; it does not silently include every page of a prefix.

ZIPs contain the explicitly selected keys; there is no whole-prefix ZIP control in the current browser. ZIP links must be opened within 60 seconds and use single-use UI tokens tied to the signed-in user. If Garage cannot open a selected object, the archive can contain an `_errors.txt` entry listing unavailable keys; inspect it before treating the archive as complete. If a link has expired or was already consumed, prepare a new archive from the selection. These links are not public share links.

## Share one object

The operator must configure a browser-reachable `S3_PUBLIC_ENDPOINT_URL` first.

1. Select exactly one object.
2. Choose **Share** to open the dialog, then choose **Share for 1 hour**, **Share for 24 hours**, or **Share for 7 days**.
3. Copy the returned link and give it only to the intended recipient.

The link is a presigned Garage S3 URL. Its recipient does not need a UI account, and anyone holding the URL can read the object while it remains valid. The maximum supported expiry is seven days. The internal S3 endpoint is separate from this public address.

If the link opens an unreachable hostname, correct the public endpoint and generate a new link. Changing a UI viewer's permissions prevents future issuance through that account; an already issued S3 URL is governed by its expiry and the underlying Garage credential/object access.

See [Users and authentication](Users-and-authentication.md) to change viewer permissions.
