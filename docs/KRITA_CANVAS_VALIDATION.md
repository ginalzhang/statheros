# Krita canvas setup: operator validation

Implementation and automated fake-input checks do not establish live Krita acceptance. Execution stops before these steps so the operator can validate the installed app and report results. Do not treat an unavailable external display or camera as a passed test.

## Excluding the bottom info/status bar (v7)

The operator confirmed the v6 controls placement and identified the unwanted region as Krita's info/status bar containing zoom/document details. The older pasted tree already placed its separate bottom bar outside the old workspace; that report alone does not explain the current highlighted region. This build conservatively trims the reviewed suggestion against a measured, unambiguous status-bar-shaped Accessibility frame when it overlaps the workspace. It uses the observed boundary, not a fixed-height inset. Qt maps status bars to generic `AXStaticText`, so the shape/position/child structure is supporting evidence for a suggestion rather than proof of exact viewport identity. Missing or ambiguous geometry leaves the suggestion unchanged.

The preview, mouse coordinates, control placement, and confirmation outline now also use each overlay's measured Electron content origin. [Electron documents that macOS can clamp requested window coordinates below the menu/tray region](https://www.electronjs.org/docs/latest/api/browser-window#wingetbounds). Previously the renderer assumed the requested display origin was the actual content origin, which could shift a correct workspace outline down over the status bar. This is a plausible explanation, not a verified diagnosis of the live app. Preview/confirmation submissions carry their surface frame and are rejected if the actual frame has moved since that renderer state. Diagnostics record the actual `surfaceBounds` alongside the display and panel rectangles.

1. Quit the older Steady instance and open `out/status-bar-v7/Steady-darwin-arm64/Steady.app`. Keep camera capture and real input off. Open a disposable Krita document, select its display in Steady Settings, close Settings, and return to Krita.
2. With Krita's info/status bar visible, choose **Review suggested workspace** after the scan finishes. Does the highlighted rectangle now end above the bar showing zoom/document details? Does its top edge also match the intended workspace, and do setup controls still occupy Steady's panel location? Inspect the actual outline before confirming.
3. Choose **Use canvas**. Does setup finish with input paused, and does the brief confirmation outline occupy the same rectangle you just reviewed? Reopen mouse selection and drag between two recognizable screen positions; does the rectangle follow the physical pointer at both corners? Include a drag near the visible viewport's top edge, cancel, and check that selection clicks left no marks in the disposable document. The coordinate correction does not itself establish full physical overlay coverage; that check remains unverified until performed. Reconfirm a workspace and leave Krita idle for sixty seconds; does it stay confirmed without a document-change warning?
4. Cancel any active setup before changing Krita's layout. In Krita, toggle **View → Show Status Bar** off, wait for a scan, then open workspace review again. Does the suggestion avoid keeping an unnecessary fixed-height gap at the bottom? Cancel, restore the status bar, wait for another scan, and check that the bar is excluded again. A previously confirmed canvas may need reselection after this actual layout change. [Krita's View menu reference](https://docs.krita.org/en/reference_manual/main_menu/view_menu.html) describes the status-bar toggle.
5. Repeat the visible-bar review in fullscreen. If the bar is still included, cancel without redrawing and copy **Canvas diagnostics** into the chat, noting windowed/fullscreen and whether the bar was visible. Current geometry is needed because the older report shows a different relationship between the workspace and bar. The scan may retain the wider suggestion when it cannot identify the bar confidently; that is an unverified limitation, not a passing viewport test.

Please report visible-bar exclusion, hidden-bar behavior, fullscreen behavior, and whether confirmation stays paused. Exact viewport/document-page detection remains unavailable for the anonymous workspace; scrollbars, rulers, and document tabs may still need manual adjustment. No live GUI checks run automatically.

## Selection controls at the Steady panel (v6)

The operator requested that setup use the floating Steady panel's location instead of adding controls over another part of the drawing area. The earlier overlap message does not by itself establish visible overlap. Only the persistent Steady window rectangle participates in exclusion; temporary selection controls are not an additional excluded region.

1. Quit older Steady instances and open `out/panel-selection-v6/Steady-darwin-arm64/Steady.app`. Keep camera capture and real input off. Open a disposable Krita document and leave Krita foreground. Select its display in Settings and close Settings if needed.
2. Note where Steady's floating panel sits, then choose **Select with mouse**. Do the selection controls occupy that same area, with no extra controls at the bottom center of the display? Instructions and errors may scroll inside the panel; **Use canvas**, **Retry**, and **Cancel** should stay accessible. The full-display surface still captures selection clicks.
3. Drag a valid rectangle, try **Retry**, redraw, and choose **Use canvas**. Does the normal Steady interface reappear at that location, with canvas confirmed and input paused? Repeat with **Review suggested workspace**, first windowed and then in fullscreen. The suggested region may still include the bottom info bar.
4. Reopen setup and cancel with **Cancel**, then repeat with Escape. Do both restore the normal interface and leave canvas unconfirmed and input paused? If selection is triggered with a collapsed panel, setup controls temporarily use its expanded footprint at the same origin; the original collapsed panel returns on exit.
5. Move Steady near a screen edge, then reopen selection. If the expanded controls would be clipped, Steady moves to the nearest reachable position on the selected display. If Steady was on another display, it moves onto the selected display. Do all three buttons remain visible, and do the normal panel and controls still share the same origin? Treat unavailable multi-display hardware as unverified.
6. If a panel-overlap error appears where the canvas looks clear of Steady, cancel setup without redrawing, open **Canvas diagnostics**, and choose **Copy canvas diagnostics**. Share the report and exact error. The report now includes `lastSelectionValidation`: the selected rectangle, owning display, actual persistent panel, temporary controls frame, acceptance result, and computed persistent-panel intersection. No images or raw document names are included. Merely covering an area with temporary controls must not add another canvas exclusion.

Please report control placement, button accessibility, restoration after confirmation/cancellation, and fullscreen behavior. Live GUI behavior remains unverified until these steps are performed by the operator.

## Fullscreen review and idle stability (v5)

The operator confirmed that the v4 suggested workspace is passable, although it includes the bottom info bar. Windowed confirmation works. Fullscreen confirmation failed because the workspace overlapped the floating panel, and a document-change warning still occurred while idle. Exact painting viewport identification remains unavailable.

This build fits the suggestion into the largest usable rectangle clear of the panel before showing it for review. It does not relax panel exclusion or confirm the adjusted rectangle automatically. If no rectangle of at least 100 × 100 points can fit, the original outline remains visible with an error for manual redraw.

1. Quit the older Steady instance and open `out/workspace-stability-v5/Steady-darwin-arm64/Steady.app`. Keep camera capture and real input off. Open a disposable document in Krita, select its display in Steady Settings, close Settings, and return to Krita. Recover the helper if macOS requires renewed Accessibility authorization for the revised build.
2. Put Krita in fullscreen and wait for the workspace scan. Choose **Review suggested workspace**. When the original suggestion would overlap Steady, is the highlighted rectangle now reduced to avoid the panel, with an explanation? Choose **Use canvas** without redrawing. Does confirmation succeed, return to Krita, and leave input paused? If the panel covers almost all of the workspace, cancel and move it before retrying.
3. Leave the confirmed document untouched for at least sixty seconds. Does it remain confirmed without a document-change warning? Repeat in windowed mode after reconfirming. If an idle warning returns, immediately open **Canvas diagnostics**, choose **Copy canvas diagnostics**, and paste the report and exact warning into the chat. The report contains hashes and geometry rather than document names or images.
4. With a confirmed selection, zoom in and out without changing the outer viewport. Does the canvas stay confirmed? The title's memory readout and dirty marker should not represent document identity changes. Actual viewport changes still require reselection. Because the anonymous workspace is not an exact page rectangle, reselect if your intended drawing region moves within it.
5. Switch to a second document with a different name. Does the canvas become unconfirmed with a document-change message? Confirm again, then resize or move Krita; that should still invalidate the rectangle with the window move/resize message. Confirm again and resize a dock enough to change the exposed workspace; after a complete rescan, that should also invalidate it.
6. Open review again, drag a rectangle over the Steady panel, and check that **Use canvas** is disabled with the overlap explanation. Draw a valid replacement to enable it. Test **Retry**, **Cancel**, and Escape; cancellation must leave setup unconfirmed and input paused.

Please report fullscreen confirmation, sixty-second idle stability in both modes, zoom behavior, and document-switch/resize invalidation separately. Bottom info bar inclusion remains a known limitation; do not interpret this workflow as exact document-page detection. Mixed-scale external displays, display removal, and live input behavior still need operator validation on available hardware.

## Suggested workspace review

The operator confirmed that resizing invalidates the canvas correctly in v3. The supplied diagnostics show stable window/document metadata and an unnamed central group chain, while exact viewport identification remains unavailable. The user chose to review a highlighted workspace visually and confirm or redraw it.

1. Quit the older Steady instance and open `out/workspace-review-v4/Steady-darwin-arm64/Steady.app`. Keep camera capture and real input off, select Krita's display in Settings, close Settings, and return to a disposable Krita document. Grant Accessibility to the revised packaged build if macOS requires it, then recover the helper.
2. Wait up to ten seconds for the scan. Choose **Review suggested workspace** when it appears on the floating panel. Does the overlay highlight the large central document workspace, excluding the left tools and right docks? No coordinate interpretation is needed.
3. Look at the highlighted rectangle. Does it include document tabs, rulers, or scrollbars? If so, drag a replacement rectangle around the intended drawing area. If the suggested rectangle overlaps Steady, its border should show an error and **Use canvas** should remain disabled; redraw a smaller rectangle that excludes the panel.
4. Choose **Use canvas** for a valid rectangle. Does the overlay close, return to Krita, and leave Steady paused with a manually confirmed canvas? The suggested workspace must not become confirmed merely by opening its preview.
5. Open workspace review again, choose **Retry**, and wait several seconds. Does the old suggestion stay cleared while live status updates arrive? Test Cancel/Escape too; both should leave the canvas unconfirmed and paused.
6. Confirm a rectangle again, leave Krita idle for fifteen seconds, then resize or move the window. Does idle selection remain confirmed and a real geometry change invalidate it as before?
7. Confirm again, then resize a dock so the central workspace visibly changes width. After a complete Accessibility rescan, does Steady clear the canvas and explain that the document workspace changed? A temporarily incomplete scan should not invalidate unchanged workspace bounds. If the workspace is no longer exposed, reselect manually and report that limitation.

Please report: whether the review button appeared, what the highlighted area contained, whether redrawing/Use canvas/Retry/Cancel worked, and whether idle/resize behavior stayed correct. If the review button never appears, copy Canvas diagnostics again. This is a user-reviewed workspace suggestion, not a claim that Krita exposes an exact painting viewport.

## Idle invalidation and Accessibility diagnostics

The v2 operator report established that the search completed after inspecting 117 elements without recognizing a viewport, and that manual setup sometimes reported **Krita document or layout changed** while idle. Completing the search does not establish whether the drawing area has an identifiable Accessibility element. The next build stabilizes window/document identity, removes unrelated widget-tree hash changes from invalidation, and provides a bounded structural report so recognition changes can be based on the actual exposed tree.

1. Quit older Steady instances. Open `out/canvas-diagnostics-v3/Steady-darwin-arm64/Steady.app`, keeping camera capture and real input off. Open a disposable Krita document, choose its display in Steady Settings, close Settings, and return to Krita. Grant Accessibility to the new packaged build if macOS requires it, then recover the helper.
2. Choose **Detect canvas** and wait ten seconds for the completed result. Open **Canvas diagnostics** on the Steady panel and click **Copy canvas diagnostics**. Paste the copied report into this chat. It contains geometry, roles, technical widget identifiers, and hashed identity, without window titles, document text, or images.
3. Choose **Select with mouse**, confirm a valid rectangle, and leave Krita unchanged for at least fifteen seconds. Does the canvas remain confirmed? If an unexpected invalidation appears, copy the diagnostics again immediately. The report records the exact changed fields and before/after metadata; please include the visible message too.
4. Select a rectangle again if needed, wait one second, then resize Krita. Does it become unconfirmed with a window move/resize message while remaining paused? Reselect and repeat by moving the window. Copy diagnostics if either change is missed.
5. Confirm another rectangle and switch Krita documents. Does the document identity change invalidate it? A dock/zoom/pan change can require explicit reselection when the viewport itself is not identifiable; the report must not equate unrelated widget-tree changes with a changed drawing region.

Please report: the detection message, the copied report, whether idle selection stayed confirmed, whether move/resize still invalidated it, and any unexpected status messages. This build does not claim to recognize an anonymous viewport without supporting evidence from Krita.

## Viewport and resize retest

The operator reported that mouse selection and Cancel worked on the initial build. Automatic detection reported **Krita Accessibility inspection was incomplete**, and resizing Krita did not invalidate manual bounds. The revised build separates root-window monitoring from viewport discovery and continues viewport search across polls. These revised behaviors still need operator validation.

1. Quit the older Steady instance, then open the revised build at `out/canvas-accessibility-v2/Steady-darwin-arm64/Steady.app`. This separate folder distinguishes the retest build from the initial app. Leave real input and the camera off. Open a disposable document in Krita 5.3.4, select its display in Steady Settings, close Settings, and return to Krita. If the new build lacks Accessibility permission, grant it in macOS System Settings → Privacy & Security → Accessibility, recover the helper, and retry.
2. Choose **Detect canvas**, wait up to ten seconds without changing Krita, and report the exact status text. If a viewport is found, does its outline exclude toolbars/docks and include the desired drawing pane? If it is still searching or unavailable, report that message rather than treating it as a pass.
3. Choose **Select with mouse**, drag a valid rectangle excluding Steady, and choose **Use canvas**. Wait one second for root-window metadata, then resize Krita. Within roughly one polling interval, Steady should clear the confirmed canvas and remain paused, even when automatic viewport discovery is unavailable. Does that happen?
4. Select the rectangle again, wait one second, then move Krita without resizing it. Does the canvas become unconfirmed? Separately, start another mouse selection and switch applications: the overlay should close and stay canceled.
5. Select a rectangle and leave Krita unchanged for ten seconds. Does it stay confirmed without repeated invalidations? Make a first brush mark only if you elect to enable real input and complete calibration; a document's modified marker should not by itself count as a document switch.
6. If automatic detection succeeded, choose **Detect canvas** again, then resize Krita or toggle a dock. Do the viewport bounds update while leaving input paused? If another display is available, repeat selection and resize there and report its scale/arrangement.

Questions to answer: What exact detection message appeared? Did manual resize and move invalidation work? Were there any unexpected invalidations while idle? Did mouse selection and Cancel still work? Which display and Krita layout did you use?

## 1. Open the current packaged build

1. Quit older Steady copies. Open `out/Steady-darwin-arm64/Steady.app` from this checkout. In Finder, use Go → Go to Folder and enter the absolute path if necessary: `/Users/issacwoo/Documents/calhacks-26/out/Steady-darwin-arm64/Steady.app`.
2. Open Krita 5.3.4 with a new, disposable document. Leave it unrotated initially. Choose a brush with a clearly visible color.
3. Keep real input disabled for the first selection tests. Camera capture and calibration are unnecessary for these tests.
4. In Steady Settings, select the display containing Krita, then close Settings and return to Krita. Move the floating panel away from the rectangle you intend to select.

Report: Did the packaged app launch? Which macOS/Krita versions, display scaling, and displays did you use? Was a camera running or calibration already saved?

## 2. Check mouse setup without tracking

1. With Krita foreground, choose **Select with mouse** on Steady. Confirm an overlay appears on the selected display and that drawing remains paused.
2. Drag from bottom-right to top-left across an area larger than 100 × 100 logical points. Confirm the rectangle follows the physical mouse and **Use canvas** becomes available. The Steady panel must remain outside the rectangle.
3. Choose **Retry**. Confirm the preview disappears and **Use canvas** becomes unavailable.
4. Drag a rectangle smaller than 100 points in either dimension. Confirm an error appears and it cannot be applied. Retry with a valid rectangle.
5. Choose **Use canvas**. Confirm the overlay closes, Krita returns to the foreground, a brief outline matches the selected area, and Steady remains **PAUSED** with **Resume required**.
6. Inspect the disposable document: selecting, retrying, and confirming must not have painted any marks or activated Krita controls.
7. Begin another selection and choose **Cancel**. Repeat with Escape. Both should close the overlay and leave the canvas unconfirmed and input paused.
8. Start selection again, then switch to another application. The overlay should close and stay canceled without bringing Krita back over the application you chose.

Report: Which steps passed or failed? Did any selection click paint, did the cursor move unexpectedly, did focus return incorrectly, or did the overlay appear on the wrong display? Include the exact status/error text for failures.

## 3. Check Accessibility detection

1. Return to Krita and choose **Detect canvas**. If Accessibility permission is missing, grant it to this packaged Steady build in macOS System Settings → Privacy & Security → Accessibility, then use **Recover helper** and retry. Rebuilding may cause macOS to require permission for the new packaged identity.
2. If detection succeeds, inspect the outline. A labeled **Drawing viewport** may include gray workspace, but it must exclude toolbars, docks, and the window frame. Confirm setup leaves input paused.
3. Move/resize Krita, toggle a dock, switch to a second disposable document, and toggle fullscreen/canvas-only mode, one action at a time. Observe whether the detected bounds refresh and leave input paused.
4. Leave the layout unchanged for at least ten seconds. It should not repeatedly recreate the outline or announce canvas changes.
5. Zoom and pan. A detected viewport may remain unchanged because its on-screen bounds did not change. Exact artwork-edge following is not required for a viewport result.
6. If detection is unavailable, record the exact explanation and use **Select with mouse**. Missing or ambiguous Accessibility geometry is an accepted fallback, not a detection pass.
7. No step should request Screen Recording permission or install anything in Krita.

Report: Did detection succeed or fall back? If successful, did it identify the drawing viewport correctly? Which layout/document changes updated or invalidated the bounds, and were any unchanged observations disruptive?

## 4. Check manual bounds and displays

1. Select an area manually, then wait ten seconds. Automatic observations must not replace it. Choose **Detect canvas** only when you intend to switch back to automatic mode.
2. Switch documents or move/resize Krita. If Accessibility exposes the change, manual bounds should become unconfirmed and require reselection. If it does not, record that limitation and reselect yourself.
3. For manual artwork bounds, reselect after zooming/panning when the page moves relative to the screen. Do not assume invisible document changes are observable through Accessibility.
4. Repeat mouse selection on each available display, including Retina and an external display with different scaling. If possible, place the external display to the left of or above the main display in macOS display arrangement to exercise negative coordinates.
5. Repeat on Krita fullscreen and after changing Spaces. Selection must align with the visible drawing area without scaling or origin offsets.
6. If an external display is available, disconnect it during selection. The overlay must close or invalidate; stale bounds must not be accepted on another display.

Report: Did outlines and physical selection align on each arrangement? Which display/fullscreen/Spaces cases could you actually try? Mark unavailable equipment as not tested.

## 5. Optional real drawing acceptance, after the checks above

1. Use the disposable document. Select your camera/mode, start capture, and complete five-position calibration if necessary. Then explicitly enable real input in Settings.
2. Close Settings, return to Krita, and select/detect the canvas again after setup changes. Wait for valid tracking, then explicitly choose **Resume**.
3. Draw a short stroke using the existing pen controls. Pause with F9. Confirm input releases and does not restart automatically.
4. While paused, choose **Select with mouse**. Confirm tracking cannot move the physical pointer while you drag. Apply the selection and confirm drawing remains paused until another explicit Resume.
5. If automatic detection worked, change a supported layout while drawing and confirm it releases input and requires Resume after the bounds update. Leave the layout unchanged and check that ordinary drawing is not repeatedly paused.
6. Quit and reopen Steady. Confirm the previous rectangle is not silently trusted. Fresh automatic detection may establish a new rectangle while still leaving input paused.

Report: Did actual drawing work? Did the pen ever remain held, resume automatically, or draw outside the selected rectangle? Which camera and tracking mode did you test? Stop testing and use F9 or Settings → Emergency release if a release failure occurs.

## Result template

```text
Build path:
macOS / Krita version:
Displays / scaling / arrangement:
Camera / mode (or camera off):
Mouse selection, reverse drag, Retry, undersized rectangle:
Use canvas, focus restoration, outline alignment:
Cancel / Escape / application switch:
Any accidental Krita marks from setup clicks:
Automatic detection result and exact status text:
Document / dock / resize / fullscreen changes:
Manual selection precedence:
External display / negative origins / Spaces:
Real drawing and release (or not tested):
Failures with reproduction steps:
```
