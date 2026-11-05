# Plan 4: First run and household

Agreed 2026-11-05 from the reviews; fourth of four (after [robustness and scale](2026-11-05-3-robustness-and-scale.md)).

**Goal:** someone who downloads the app without a server understands it in a minute; an invited member goes from the invite to music in under two minutes; the owner's first steps lead to music, not settings; and the household shares requests and playlists like a family, not a set of strangers.

## 1. The welcome screen explains itself — S–M

The iOS welcome offers only "Add a server" (`SignIn/WelcomeView.swift`). Add:
- "New to Playarr?": what it is, what you need (a server at home), and a link to setting one up.
- "Try it without a server": the demo library the app already has (`Demo/`), clearly marked as a demo, with a way back. It also makes App Review independent of the owner's home server.

## 2. Invites open the app — S

Setup codes link to `https://<server>/redeem?code=` (`apps/server/src/accounts/setupCodes.ts`), which opens the web page; the app only understands `playarr://redeem`. The redeem page gets "Open in the Playarr app" (the `playarr://` link, with the server address) and an App Store link; later, universal links (`apple-app-site-association` served by the server) so the https link opens the app directly.

## 3. The owner's first steps — S

After claiming the server, the owner lands on "Add your music" (Lidarr or a folder) instead of Accounts, then on inviting the household.

## 4. Requests belong to the person who asked — M

Builds on plan 1's requests table.
- Each request records who asked; members see their own, admins see all.
- An option "Ask the owner first": members can request, the owner approves or declines (today requesting is on or off per account).
- "It's ready": when the album arrives, the person who asked is told (iOS local notification, web push, and a badge in Requests).
- **Done when** a member's request, approved by the owner from a notification, ends with the member told and playing the album.

## 5. Shared playlists the household can build together — M

Shared playlists can only be changed by their owner (`apps/server/src/playlists.ts`). An owner can make a playlist collaborative: anyone it's shared with can add, remove and reorder songs; changes show who added what.

## 6. Small things members notice — S

- "2 missing" on album pages is owner-speak: members see nothing, or "more on request" when they can request.
- The artist page's empty photo band when there's no photo.
- Now Playing on the iPhone gets a way into the queue (Up next).

## Order

2 → 1 → 3 → 4 → 6 → 5.
