# maomao

A tiny, private WebHID control surface for the Maono PD200W microphone. The entire project is three static files: there is no framework, package manager, build step, database, backend, analytics, or telemetry.

## Run locally

Serve the folder from localhost; opening `index.html` directly as a `file://` URL will not grant USB access.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in desktop Chrome or Edge. Quit Maono Link before connecting because only one application can own the microphone's HID control interface at a time.

## Publish

Upload `index.html`, `styles.css`, and `app.js` to any static host. The public URL must use HTTPS because WebHID is restricted to secure contexts.

## Supported controls

- Microphone gain and headphone volume
- Noise cancellation power and strength
- Headphone monitor source
- RGB power, brightness, effect, and fixed color

EQ scenes are intentionally unavailable until their fixed-point coefficient encoding is fully verified.
