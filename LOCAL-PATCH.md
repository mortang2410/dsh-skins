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
6. **The frost disappeared from every bubble in a long conversation.** WebKit
   stops painting `backdrop-filter` for a whole document once the page carries
   too many filtered elements. Measured in Safari on 2026-10-25 against this
   app's session page: with 233 elements carrying a non-none `backdrop-filter`,
   a control element with `backdrop-filter: blur(40px)` over live text changed
   0.1/255 of the pixels it covered, and the same control painted a full blur
   (99.3% of pixels changed, contrast sd 56.2 to 5.5) once the count fell to a
   handful. A ladder over document order still painted at 120 filtered elements
   and stopped painting at 160, 200 and 233. One real session carried 78
   reasoning plates and 117 tool/process plates, so the skin's own per-row frost
   rules reached the ceiling by themselves. `runtime/frost-window.ts` now marks
   only the rows in and near the viewport with `data-dsh-frost-near`, and the
   skin's frost rules key on that marker. Offscreen rows keep their tint and drop
   only the blur, so the live count stays near the dozen rows a viewport holds.
   The observer work follows `contracts/performance-guidelines-v1.md` R1: a
   record outside the conversation scrollport is dropped after one containment
   check, an added subtree is queried on its own, and the full scrollport scan
   runs only at install, when the shell rebuilds the scrollport, or when one
   batch adds more rows than the transcript already holds. Measured in jsdom at
   1000 rows: one streamed row costs 0.2 ms of frame work instead of 25 ms, and
   100 composer or sidebar insertions schedule no scan at all. The window is
   reference-counted per document, so an overlapping boot cannot disarm the live
   one; a boot that runs before `body` exists installs once parsing reaches it;
   and a browser without `IntersectionObserver` keeps every plate blurred, which
   is the behaviour before the window existed.

## Files

| File | Change |
| --- | --- |
| `src/client/background.ts` | `syncBlur()` keeps the blur layer with a wallpaper; `hasWallpaper()` removed. |
| `src/client/wallpaper.ts` | Mirror constants/helpers, `WallpaperMirrorPrefs`, mirror writes in `persist()`, selection writes in `applySelection()`/`clearSelection()`, `readAll()` overlay, theme-seed guard, constructor fetch guard, `fetchAndSync()` mirror guard, `restoreMirrorPrefs()`, `restoreMirroredSelection()`, rewritten `installBootRestore()`. |
| `src/client/index.ts` | Handle exposes `restoreMirrorPrefs` / `restoreMirroredSelection`. |
| `src/client/runtime/frost-window.ts` | New: sets `data-dsh-frost-near` on chat rows inside the viewport plus a 400px margin, via `IntersectionObserver` (visibility) and a `MutationObserver` scoped to the conversation scrollport. Mutation records outside that scrollport are dropped after one containment check, added subtrees are observed incrementally, and a full scrollport scan runs only at install, on a scrollport rebuild, or for an insert larger than the tracked set. Reference-counted per document; installs after `body` exists; without `IntersectionObserver` every plate keeps its blur. Marks `html` with `data-dsh-frost-window` while installed. |
| `tests/frost-window.spec.ts` | New: marker enter/leave, detached-row marker cleanup, no-observer fallback, body-late install, two installers and disposal order, scrollport scoping, zero scans for mutations outside the conversation, incremental add and late-attribute observation. |
| `src/client/runtime/boot.ts` | Installs the frost window next to the shell rendering adapter and disposes it from `shutdown()`. |
| `lib/client.js` | Shipped browser bundle. Rebuilt from `src/` with the tree's `tsdown` (0.22.14 parses this tree again, so the hand-patch caveat no longer applies); it now also carries the frost window. |
| `tests/background.spec.ts` | Asserts the layer survives a wallpaper and disappears when Background is disabled. |
| `tests/wallpaper.spec.ts` | localStorage isolation per test; mirror restore, mirror-backed refusal, and boot-restore retry tests replace the upstream #777 expectations. |

## Mirrored fields

`enabled`, `mode`, `fit`, `dim`, `wallpaperBlur`, `wallpaperOpacity`,
`pauseOnHidden`, `sound`, `volume`, `selection`, `weLibraryDirs`.

The selection mirror has exactly three writers: `applySelection()`,
`clearSelection()`, and the matched boot restore. The preferences mirror is
written only from `persist()` (user-facing setters), never from a scope
publication; writing it from a resync used to clobber it with schema defaults.

## Build (read before rebuilding)

At 0.4.4 `pnpm build` failed with the lockfile's tsdown 0.22.14:

```
[PARSE_ERROR] 'readonly' type modifier is only permitted on array and tuple literal types.
  shared/tsdown.client.ts:214:28  readonly clientPlugins?: readonly NonNullable<UserConfig['plugins']>
```

`pnpm install` triggers the same `prepare` script, so installing the package as
a git dependency would fail as well. That was the state at 0.4.4. The `tsdown`
installed in this tree (0.22.14) parses this tree again, so `./node_modules/.bin/tsdown`
now builds `lib/` from `src/` and the shipped bundle is a real build, not a hand
patch: run it after editing `src/`. `lib/client.js` then carries the same
structure as the source, including `restoreMirrorPrefs()` /
`restoreMirroredSelection()` on the handle.

Checks that do run with the current tree:

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit     # exits 0
./node_modules/.bin/tsdown                            # builds lib/ from src/
./node_modules/.bin/vitest run                        # 52 files, 766 tests
```

## Verification (live profile)

```bash
sha256sum ~/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-skin-center/lib/client.js
# expect 50fac1c3c8e4a908… (changes with every build; compare with the repo copy)
python3 ~/.dsh/check-web-plugins.py web      # exit 0 = every served plugin registers
```

The served bundle must contain `readWallpaperSelection`, `MIRRORED_WALLPAPER_FIELDS`,
`writeWallpaperSelection(match.id)`, `data-dsh-frost-near` and no `hasWallpaper`.
In the browser, with a seeded mirror, a reload restores the wallpaper and its
preferences and issues exactly one `/api/skin-center/we/inventory` GET. With a
conversation on screen, `html[data-dsh-frost-window]` is present and
`[data-dsh-frost-near]` sits on the rows inside the viewport, not on the rows far
outside it, so `document.querySelectorAll('*')` filtered through
`getComputedStyle` reports about a dozen elements with a non-none
`backdrop-filter` instead of one per row.

## Upgrading upstream

1. Fetch `upstream/main`, rebase the local commit onto the new tag.
2. Re-apply the file changes above (they touch stable functions; conflicts
   are likely only in `syncBlur()` and `installBootRestore()`).
3. Re-run `tsc`, `tsdown` and `vitest run`.
4. Confirm `lib/client.js` grew from the new `src/` and still carries
   `data-dsh-frost-near`.
5. Update the profile override and re-verify with the commands above.
