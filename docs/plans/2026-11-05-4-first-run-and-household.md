# Plan 4: First run and household

Agreed 2026-11-05 from the reviews; fourth of four (after [robustness and scale](2026-11-05-3-robustness-and-scale.md)).

**Goal:** someone who downloads the app without a server understands it in a minute; an invited member goes from the invite to music in under two minutes; the owner's first steps lead to music, not settings; and the household shares requests and playlists like a family, not a set of strangers.

**Where it stands (2026-11-07):** 1, 3, 4, 5 and 6 done (4 but for web push); 2 done but for universal links, which wait for a Playarr domain.

## 1. The welcome screen explains itself — S–M — done 2026-11-07

*Done: while no server is added, "Add a server" starts with "New to Playarr?": what Playarr is, "How to set up a server" (the repository's Getting started) and "Try it without a server", the demo library on silence (`AppModel.tryWithoutServer`). In the demo the account button is a "Demo" badge whose menu says what it is and has "Leave the demo". Every Settings panel shows made-up settings, signing out leaves the demo, and an invite link opened in it leaves it for the invite. Nothing of it is kept: its folder and settings are emptied when it starts and when it's left. App Review's notes mention it. The add-server screens now take the app's accent, like its other lists.*

The iOS welcome offers only "Add a server" (`SignIn/WelcomeView.swift`). Add:
- "New to Playarr?": what it is, what you need (a server at home), and a link to setting one up.
- "Try it without a server": the demo library the app already has (`Demo/`), clearly marked as a demo, with a way back. It also makes App Review independent of the owner's home server.

## 2. Invites open the app — S — done 2026-11-07

*Done: the redeem page's "Open in the Playarr app" on iPhones and iPads; its App Store link shows once the app is on sale (`APP_STORE_LIVE`). Universal links need a domain the app is built with, and every server has its own, so they wait for a Playarr domain.*

Setup codes link to `https://<server>/redeem?code=` (`apps/server/src/accounts/setupCodes.ts`), which opens the web page; the app only understands `playarr://redeem`. The redeem page gets "Open in the Playarr app" (the `playarr://` link, with the server address) and an App Store link; later, universal links (`apple-app-site-association` served by the server) so the https link opens the app directly.

## 3. The owner's first steps — S — done 2026-11-07

*Done: claiming opens Settings → Sources as the first of two steps ("Add your music"), which leads on to Settings → Accounts ("Invite your household") and then Home: on the web `FirstSteps` (`?first`), in the iOS app `FirstStepSection` (`Route.firstStep`, which the web's addresses open too).*

After claiming the server, the owner lands on "Add your music" (Lidarr or a folder) instead of Accounts, then on inviting the household.

## 4. Requests belong to the person who asked — M — done 2026-11-07, web push to do

*Done on the server and both apps: each request records everyone who asked (`album_request_askers`, the 27th migration in `apps/server/src/db.ts`), so an album asked for by two people is both of theirs. `GET /api/requests` gives a member their own and an admin everyone's, each with `mine`, `askedBy` (names, for admins), `approval` and `unseen`. Settings → Accounts has a third choice, "Asks an admin first: each request waits for approval" (`requestAccess: 'ask'`, members only; `canRequest` stays true, so the apps already on TestFlight still offer Request): such a request waits, shows the member Pending (also in Search and on artist pages), and comes first on an admin's Requests with Approve and Decline (`POST /api/requests/:mbid/approve`, `/decline`). Approved, it goes to Lidarr as any request; declined, the member sees "Declined by Nicola" and removes it. "It's ready": the badge on Requests (iOS's Library tab, Library row and sidebar; the web's sidebar, Library row and Library tab on phones) counts the account's requests that arrived or were declined since it last looked (`POST /api/requests/seen`), and for an admin those waiting for an answer. The toast and iOS's local notification tell only whoever asked, and tell an admin of a request that starts waiting. The demo the UI tests use has the three cases (`-UITestsRequests`, `asks-first`, `admin`). Not built: web push (the web tells only while it's open), so "approved from a notification" is from the iOS notification or the badge.*

Builds on plan 1's requests table.
- Each request records who asked; members see their own, admins see all.
- An option "Ask the owner first": members can request, the owner approves or declines (today requesting is on or off per account).
- "It's ready": when the album arrives, the person who asked is told (iOS local notification, web push, and a badge in Requests).
- **Done when** a member's request, approved by the owner from a notification, ends with the member told and playing the album.

## 5. Shared playlists the household can build together — M — done 2026-11-07

*Done: on a shared playlist its owner's ⋯ has Let others add songs, then Stop others adding; stopping sharing stops it too, and Stop sharing's Undo brings both back (`PATCH /api/playlists/:id { collaborative }`). While it's collaborative everyone it's shared with adds, moves and removes its songs, from its page (the handles, Move up and down, Remove, Songs like these), from Add to playlist, which lists it with whose it is, and on the iPad by a drop on the sidebar; its name, cover, sharing and deleting it stay its owner's, and its meta line says "Everyone can add songs". Each song keeps who added it (`playlist_items.added_by`), and one someone else added says "Added by Sam" in its row, on both apps. Apps already out ignore the new fields (`collaborative`, `canEdit`, `addedBy`), which are optional, so the new apps read older servers too. The demo has one with `-UITestsCollaborative`.*

Shared playlists can only be changed by their owner (`apps/server/src/playlists.ts`). An owner can make a playlist collaborative: anyone it's shared with can add, remove and reorder songs; changes show who added what.

## 6. Small things members notice — S — done 2026-11-07

*Done: only an admin sees an album's missing songs (grayed in the list, "3 of 5" on its card); a member who can ask for them reads "2 more songs on request" under the list, on both apps. The artist page without a photo (a compact header) and Now Playing's way into the queue came with plans 5 to 7.*

- "2 missing" on album pages is owner-speak: members see nothing, or "more on request" when they can request.
- The artist page's empty photo band when there's no photo.
- Now Playing on the iPhone gets a way into the queue (Up next).

## Order

2 → 1 → 3 → 4 → 6 → 5.
