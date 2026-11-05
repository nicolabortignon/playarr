# iOS: what to check on a real iPhone or iPad

The simulator can't check the items below. Their code is in the TestFlight builds; each line says what to do and what should happen. Tick them off here, or tell Claude which ones fail.

## iPhone

- [ ] **Every screen turns.** Turn the phone on Home, an album, an artist, a playlist, a mix, Library, Search and Queue. Each page turns and keeps working. Albums, playlists and mixes open as a gatefold, with the artwork fixed on the left and the page scrolling beside it. The artist's photo band is lower. Home's greeting and Feeling lucky share a row.
- [ ] **Now Playing sideways.** Open Now Playing with the phone on its side. On the left are the cover, the seek bar, then shuffle, previous, play/pause, next and repeat, all reachable with the left thumb. On the right are one header line (close, playing from with the time left, sleep timer, lyrics, ⋯) and the tracklist at full height, for the right thumb. Lyrics replace the tracklist in the same place.
- [ ] **The stage.** Leave sideways Now Playing alone for 12 seconds while it plays. The controls fade and the cover grows. A touch brings everything back.
- [ ] **Turn to open** (Settings → Appearance → Held sideways, off by default). With it on and a song queued, turning the phone opens Now Playing instead of turning the page. With Portrait Orientation Lock on, nothing turns or opens.
- [ ] **Screen stays on while charging.** In a stand or on a charger, sideways Now Playing keeps the screen on. Off the charger, it sleeps as usual.
- [ ] **Haptics.** These tap: play/pause, shuffle, repeat, the lyrics toggle, reordering the queue, dropping songs, and toasts. With System Haptics off, nothing taps.
- [ ] **Siri and Shortcuts.** "Play my favorites in Playarr", "I'm feeling lucky in Playarr" and "Start radio from this song in Playarr" each work. The three appear in the Shortcuts app and can go on the Action button. With nothing playing, Start radio says "Nothing playing."
- [ ] **Launch and icon.** Opening the app shows no white flash. The dark and tinted Home Screen icons look right.
- [ ] **Bold Text and Increase Contrast.** Text gets bolder, and secondary text gets brighter.

## iPad

- [ ] **Escape** on a hardware keyboard closes Now Playing. With a keyboard attached, `TEST_RUNNER_PLAYARR_DEVICE_CHECKS=1` also runs `testEscapeClosesNowPlaying`.
- [ ] **The keyboard.** Space, ←/→, Shift+←/→, ↑/↓ (volume, also while the sidebar has focus), M, S, L and / work as on the web. Holding ⌘ lists them.
- [ ] **Pointer.** Cards, rows and bar buttons highlight under it without lifting. A secondary click opens a song's or album's menu.
- [ ] **Drag.** A song dropped on one of your playlists in the sidebar shows "Added “…” to “…”". A shared playlist refuses it. Dropped on Queue, it shows "Added 1 track to queue".
- [ ] **Narrow windows.** At a third, a half and two thirds in Split View, in Slide Over, and in a small Stage Manager window, the app uses the phone's tabs and mini player with the same page open. Back at full screen, the sidebar returns with that page selected.
- [ ] **Coming back where you were.** Open an album and Now Playing, go Home, and use other apps until iOS closes Playarr in the background. Playarr comes back on that album. A force-quit opens on Home. With `TEST_RUNNER_PLAYARR_RESTORE=1`, `testComesBackWhereItWas` checks this.
- [ ] **VoiceOver.** The rotor's Headings jump between sections. A song row reads its title, artist and time, and offers its actions. The sidebar says which item is selected.

## iPhone Duo

- [ ] **Folded.** The app fits the cover screen. The tabs sit on the system's rail at the right, and the mini player floats at the foot of the page.
- [ ] **Open flat.** Now Playing shows two pages: the cover on the left, and the song, controls and Up next on the right. The crease runs between them, not through the words.
- [ ] **Propped up like a small laptop** (part open, the crease across the screen). Now Playing puts the cover or lyrics on the standing half, and the song, controls and Up next on the half lying flat.
- [ ] **Opening and closing while it plays.** Now Playing moves between those layouts as the hinge moves, without stopping the music.

## Both

- [ ] **Buttons.** Play, Shuffle, Feeling lucky, Try again, New mix and the rest look like the Request button: DM Mono, upper case, in a capsule.

## Offline (iPhone)

How downloads and offline play work is in [docs/ios/offline.md](../ios/offline.md). Install with `corepack pnpm ios:device` or TestFlight.

- [ ] **Download an album on Wi-Fi.** The button's ring fills, songs get the offline mark one by one, and Library → Downloads shows its progress and size, then the song count.
- [ ] **Lock the phone mid-download** for a few minutes. Unlocking shows it went on (iOS may slow it; it doesn't stop).
- [ ] **Kill the app mid-download** (swipe it away in the switcher) and reopen. The download goes on from where it was, not from the start of the song (the server log shows `Range: bytes=…`).
- [ ] **Mobile data** (Wi-Fi off). A new download waits; with "Allow downloads on mobile data" on, it starts; off again, the song under way stops and waits for Wi-Fi.
- [ ] **Airplane mode, play the album through.** Every song plays, levelled (no jumps between a quiet and a loud track). With DJ mix and a downloaded playlist, the transitions play as online. The lock-screen controls work.
- [ ] **Airplane mode, a queue with songs not kept.** They're skipped with "Offline: skipped songs that aren’t on this device"; with nothing kept after the current song, it stops at the end.
- [ ] **Airplane mode, browse.** Library → the downloaded album, playlist, mix and Favorites open from the cache, and Play plays them.
- [ ] **Play reports.** Play a few songs in airplane mode, then turn it off: Your listening on the web shows them.
- [ ] **Keep-ahead.** On Wi-Fi, play a queue for a minute, then airplane mode: the next 3 songs play. On mobile data: the next 1.
- [ ] **Low Data Mode.** Nothing is fetched ahead; a download you start still goes (with mobile data allowed).
- [ ] **Room.** Downloading something larger than the free space says "Not enough space on this device" with the sizes; a download that runs out says "This device is out of space for downloads: remove some in Library → Downloads", and the failed count shows on its row.
- [ ] **Remove.** Remove on a row, and "Remove all" in On this device, free the space (Settings → General → iPhone Storage → Playarr goes down).
- [ ] **Accounts.** Switching account shows its own downloads (none); switching back, they're there. Signing out of an account with downloads asks first; "Sign out and remove downloads" frees the space.
- [ ] **Backups.** Settings → [name] → iCloud → Manage Storage → Backups → this iPhone: Playarr's size is small (the audio is excluded).

## Server settings (iPhone, signed in to the real server as the owner)

- [ ] Settings shows the six server panels. The real library's sources are listed in their order, with the right counts and "Synced" times.
- [ ] Drag a source to another place and back. The web's Settings → Sources follows each time.
- [ ] Rescan a folder source: "Syncing…", then "Synced", without leaving the screen. Lock and unlock the phone during the sync: the panel picks up where it was.
- [ ] "N albums to review" (if any): decide one album, then leave the sheet. Its count went down by one.
- [ ] Organize files on a writable folder, if there is one: move one file, then undo it.
- [ ] Mixes: toggle one kind off. Home no longer shows it after a refresh. Toggle it back on.
- [ ] Analysis: the numbers match the web's.
- [ ] Accounts: add an account and share its setup link by Messages to yourself. The link opens the web's redeem page (or the app through `playarr://`). Remove the account afterwards.
- [ ] On mobile data (away from home, over HTTPS): Sources and Accounts still load and change things.
- [ ] Larger text (two steps up): no panel cuts off a button.
