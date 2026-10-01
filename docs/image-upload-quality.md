# Image upload quality

The Media Library upload confirmation dialog offers **Default** (initial
selection) and **High**. The choice applies to every image in that upload.
It is sent as `imageQuality` and read by the existing processing pipeline;
it is not a global setting and does not reprocess existing media.

| Profile | Longest side | WebP quality | AVIF quality | Responsive sizes |
| --- | --- | --- | --- | --- |
| Default | 1920px | 80 | 50 | 320, 500, 750, 1000px |
| High | 3840px | 90 | 60 | 320, 500, 750, 1000, 1440, 1920, 2880px |

Both include a thumbnail and the capped master. Smaller originals are never
upscaled. High WebP and AVIF variants encode directly from the temporary source
file to avoid repeated lossy compression. The browser chooses a version using
rendered width and pixel density; High does not force a 3840px mobile download.

The High notice explains larger files, potentially slower uploading/loading,
and that low-resolution originals cannot gain detail. Re-upload original
artwork with High to improve an image previously capped by Default.

The full-size AVIF twin resizes by master width rather than fitting into two
rounded dimensions, preventing a one-pixel width loss that would suppress the
frontend AVIF ladder. Larger-than-WebP AVIF files are still discarded.

Existing automated Culture Gallery uploads without an explicit choice retain
their 2560px/quality-90 profile. An explicit dialog choice takes precedence.
GIF behavior is unchanged. This selector belongs to the standard Media Library
upload flow; the dedicated Product Deal background-removal uploader is unchanged.
