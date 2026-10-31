# Vendored AraminConsole: build recipe and local patches

This folder holds a vendored copy of AraminConsole (MIT, https://github.com/ARaminco/AraminConsole,
v0.1.0, commit 279b8e3). The template keeps its own name; the product built from it is Aramis.
When you re-vendor, redo steps 1 and 2 below, then apply every patch in step 3, then run
`node tests/verify-console-ui.mjs`.

## 1. How the files are produced

Not the full `dist/` bundle: a custom module build, about a third of the size.

```
cd C:\Projects\AraminConsole
node scripts/build.mjs --modules=shell,overlays,notify,pwa,chart --out=<tmp>
```

`core`, `customizer` and `langpicker` come in as dependencies, so the header reads
"core, shell, overlays, notify, pwa, chart". Copy these into this folder:

| from `<tmp>`              | to                          |
| ------------------------- | --------------------------- |
| `aramin-console.min.css`  | `aramin-console.min.css`    |
| `aramin-console.min.js`   | `aramin-console.min.js`     |
| `icons.svg`               | `icons.svg`                 |
| `fonts/vazirmatn-variable.woff2`, `fonts/OFL.txt` | `fonts/` |

`LICENSE` is `dist/LICENSE.txt`; `LICENSE-lucide.txt` is copied unchanged.

## 2. Files that are byte-identical to the build

`aramin-console.min.css`, `LICENSE`, `LICENSE-lucide.txt`, `fonts/*`.

## 3. Patches applied on top of the build (re-apply after every re-vendor)

Reason for all of them: Aramis serves `Content-Security-Policy: style-src 'self'`, which forbids
inline `style=""` attributes and `<style>` elements created at runtime. The template only does this in a
few places; each one is rewritten to use CSSOM calls or a `<meta>` marker, which CSP allows.

### aramin-console.min.js (5 lines differ from the build: 2, 71, 97, 421, 485; nothing else)

1. Line 2, module-loader placeholder: `const st=document.createElement('style');st.dataset.acModule=n;`
   becomes `createElement('meta')`. It is only a marker (it never carries CSS), and a runtime `<style>`
   element is blocked by CSP.
2. Lines 97, 421 and 485, the lookups that test whether a module's CSS is already present
   (`link[data-ac-module="${name}"], style[data-ac-module="${name}"]`; lines 421 and 485 use `${NAME}`):
   change `style[data-ac-module` to `meta[data-ac-module` so they find the marker from edit 1.
3. Line 71, `inkLayer()` (the sliding highlight in the rail, tab bar and palette). Replace
   `c.style.cssText=\`inline-size:${geo[i][2]}px;block-size:${geo[i][3]}px;transform:translate(${geo[i][0]}px,${geo[i][1]}px)\`;`
   with three `c.style.setProperty(...)` calls
   (`inline-size`, `block-size`, `transform`). Assigning `cssText` is blocked by CSP,
   `setProperty` is not.

### icons.svg (1 edit)

The sprite root `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">` becomes
`<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">`
(inline `style` is blocked by CSP; a 0x0 sprite is equally invisible and `<symbol>` references still work).

## 4. Not patched on purpose (for the next person)

- The template's own command palette (`.ac-palette`, Ctrl/Cmd+K listener on `document`) is left in
  the bundle. Aramis has its own palette, which also searches memory, chats and runs, so the template one
  must never open. This is done without touching the vendor file: `console/public/app.js` registers a
  keydown listener on `window` in the capture phase that calls `stopPropagation()` for Ctrl/Cmd+K,
  so the template's listener on `document` never sees the key (also covers non-Latin layouts via
  `event.code`). If a future template version binds the shortcut on `window` in capture phase too,
  check `Ctrl+K` again: exactly one `.palette.open` and zero `.ac-palette` in the DOM.
- Template palette API (`AC.palette.add`) is unused by Aramis.
- `html` and `body` use `overflow-x: clip` (in `app.css`), as the template does. Do not use `hidden`: it turns
  the body into a scroll container and the sticky app bar and large-title collapse stop working.

## 5. Quick check after re-vendoring

1. `grep -c "style.cssText" aramin-console.min.js` should be 0.
2. `grep -c "createElement('style')" aramin-console.min.js` should be 0.
3. `grep -c 'style="display:none"' icons.svg` should be 0.
4. Open the console with the browser console visible: no "Refused to apply inline style" or
   "Refused to create a style" messages on the home page, the rail flyout, the tab bar and the palette.
