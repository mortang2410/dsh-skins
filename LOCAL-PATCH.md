# Local patch set (mortang2410 fork)

This fork of [`zhu1090093659/dsh-skins`](https://github.com/zhu1090093659/dsh-skins)
carries the wallpaper fixes the local DSH web profile runs. Upstream remains
untouched: every change is additive and documented here.

Base: tag `v0.4.4` (commit `540acca`). Package name and plugin id stay
`@linxin666/dsh-client-ui-skin-center`; the profile registers the fork through
`pnpm.overrides`, so nothing is renamed.

## Why

1. **Background blur was inert with a wallpaper.** Upstream `syncBlur()` removed
   the blur layer whenever `html[data-dsh-wallpaper-active]` was set (#777
   "decouple"), so "Blur when empty" and "Blur with content" did nothing while a
   wallpaper was mounted. The wallpaper media layer sits at `z-index:-3` and its
   scrim at `-2`; the blur layer at `-1` samples the wallpaper. The fork keeps
   the layer and lets the two sliders act on the wallpaper, as their labels say.
2. **Wallpaper selections and preferences did not survive a reload.** Every
   `skin-wallpaper` field is `.volatile()`: the Host keeps none of them, so
   `scope.set()` answers `false` and nothing persists Host-side. The fork mirrors
   the selection (`dsh-skin-wallpaper-selection`) and preferences
   (`dsh-skin-wallpaper-prefs`) in localStorage and overlays them on every
   `readAll()`.
3. **The refused-write verdict was a false alarm.** Because the Host refuses
   those writes, the card reported "the Host did not accept the wallpaper
   setting" for a wallpaper that did persist through the mirror. The verdict is
   suppressed for mirrored fields only; transport errors still surface.
4. **Double inventory fetch per boot.** With a mirrored selection the
   constructor's `fetchAndSync()` and `installBootRestore()` both fetched the
   inventory. The constructor now fetches only for a Host-stored selection, and
   `fetchAndSync()` skips a selection that exists only in the mirror.
5. **One failed inventory scan ended the boot restore for the page.** The
   restore now retries 8 times at 600 ms, keeps the selection it started with,
   and never writes to the Host at boot.

## Files

| File | Change |
| --- | --- |
| `src/client/background.ts` | `syncBlur()` keeps the blur layer with a wallpaper; `hasWallpaper()` removed. |
| `src/client/wallpaper.ts` | Mirror constants/helpers, `WallpaperMirrorPrefs`, mirror writes in `persist()`, selection writes in `applySelection()`/`clearSelection()`, `readAll()` overlay, theme-seed guard, constructor fetch guard, `fetchAndSync()` mirror guard, `restoreMirrorPrefs()`, `restoreMirroredSelection()`, rewritten `installBootRestore()`. |
| `src/client/index.ts` | Handle exposes `restoreMirrorPrefs` / `restoreMirroredSelection`. |
| `lib/client.js` | Shipped browser bundle, hand-patched at 0.4.4 (see build caveat). |
| `tests/background.spec.ts` | Asserts the layer survives a wallpaper and disappears when Background is disabled. |
| `tests/wallpaper.spec.ts` | localStorage isolation per test; mirror restore, mirror-backed refusal, and boot-restore retry tests replace the upstream #777 expectations. |

## Mirrored fields

`enabled`, `mode`, `fit`, `dim`, `wallpaperBlur`, `wallpaperOpacity`,
`pauseOnHidden`, `sound`, `volume`, `selection`, `weLibraryDirs`.

The selection mirror has exactly three writers: `applySelection()`,
`clearSelection()`, and the matched boot restore. The preferences mirror is
written only from `persist()` (user-facing setters), never from a scope
publication; writing it from a resync used to clobber it with schema defaults.

## Build caveat (read before rebuilding)

`pnpm build` does **not** run at this tag with the lockfile's tsdown 0.22.14:

```
[PARSE_ERROR] 'readonly' type modifier is only permitted on array and tuple literal types.
  shared/tsdown.client.ts:214:28  readonly clientPlugins?: readonly NonNullable<UserConfig['plugins']>
```

`pnpm install` triggers the same `prepare` script, so installing the package as
a git dependency would fail as well. `lib/client.js` in this fork is therefore
the 0.4.4 bundle with the changes above applied by hand; `src/` carries the same
changes for the day the config parses again (or for a rebase onto a newer
upstream). The two are not byte-identical in structure: the bundle sets fields
directly, the source exposes `restoreMirrorPrefs()` / `restoreMirroredSelection()`
on the handle.

Checks that do run with the current tree:

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit     # exits 0
./node_modules/.bin/vitest run tests/wallpaper.spec.ts tests/background.spec.ts
```

## Verification (live profile)

```bash
sha256sum ~/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-skin-center/lib/client.js
# expect dc4095da10db8c88…
python3 ~/.dsh/check-web-plugins.py web      # exit 0 = every served plugin registers
```

The served bundle must contain `readWallpaperSelection`, `MIRRORED_WALLPAPER_FIELDS`,
`writeWallpaperSelection(match.id)` and no `hasWallpaper`. In the browser, with a
seeded mirror, a reload restores the wallpaper and its preferences and issues
exactly one `/api/skin-center/we/inventory` GET.

## Upgrading upstream

1. Fetch `upstream/main`, rebase the local commit onto the new tag.
2. Re-apply the six file changes above (they touch stable functions; conflicts
   are likely only in `syncBlur()` and `installBootRestore()`).
3. Re-run `tsc` and the two spec files.
4. Replace `lib/client.js` with the new upstream bundle plus the same hand edits,
   or rebuild once the tsdown config parses.
5. Update the profile override and re-verify with the commands above.
