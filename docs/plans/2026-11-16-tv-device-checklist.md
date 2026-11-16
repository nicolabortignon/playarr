# TV: what to check on the real TV

The emulator can't check the items below (plan 9 §8). They're for the owner's Philips 65OLED935, with a build from
`pnpm tv:install`, or a release once one exists ([tv/release.md](../tv/release.md)). Each line says what to do and
what should happen. Tick them off here, or tell Claude which ones fail; `pnpm tv:logs` has the app's log.

## First

- [ ] **The readings.** `pnpm tv:device-info` and `pnpm tv:meminfo` (after `pnpm tv:install`). Their numbers go in
  plan 9's table of **The TV**: the Android version, the low-RAM flag, the heap limit and the memory free.
- [ ] **On the home screen.** Playarr's banner shows in the TV's launcher, and opens the app.

## The remote

- [ ] **Remote only.** Sign in, browse Home, Library, an album, an artist, Search, Discover and Settings, play, pause,
  skip and seek, with the remote alone. The focus is always visible, and never lost.
- [ ] **Back.** Back goes up a page, then to the rail, then out of the app. It never jumps somewhere unexpected.
- [ ] **Media keys anywhere.** With music playing, the remote's play/pause, next and previous keys work from every
  page, from another app, and from the TV's home screen.
- [ ] **Voice search.** Where the remote has a microphone, the keyboard's microphone key types a search by voice.

## Playing

- [ ] **Gapless.** An album known to be gapless (a live album, or one with tracks that run into each other) plays across
  its joins without a gap or a click.
- [ ] **DJ mix.** With Settings → Playback → Transitions on DJ mix, a playlist of songs that aren't an album plays its
  joins as the server's mixes, on the beat, with no skip at either end of a transition.
- [ ] **Even volume.** A quiet old song and a loud new one, one after the other, sound equally loud, as on the iPhone.
- [ ] **Original.** With Quality on Original, songs play lossless: the server's levelled WAV where even volume knows
  the song, else its own FLAC up to 16 bits and 48 kHz. A 24-bit song even volume doesn't know plays as High (the TV
  can't decode it). No stutter over Wi-Fi.
- [ ] **The Now Playing card.** The TV's own media controls show the song, its cover and the buttons while it plays.
- [ ] **Home and the screensaver.** Start an album, press Home, open another app, then leave the TV until the
  screensaver comes on. The music plays on throughout, and Playarr is where it was when opened again.
- [ ] **Screen off.** Where the TV can turn its screen off and keep playing sound, the music plays on.
- [ ] **A dead spot.** Turn the router's Wi-Fi off for 20 seconds partway through a song. The music stops where the
  buffer ran out, and goes on from there by itself once the network is back.

## Memory and speed

- [ ] **Under 200 MB.** After an hour of browsing and playing, `pnpm tv:meminfo`'s total stays under 200 MB.
- [ ] **No jank.** Home's rows scroll smoothly from side to side and up and down, covers coming in as they're reached.
- [ ] **Reclaimed in the background.** Open an album, press Home, and open a few big apps (YouTube, Netflix) until the
  TV closes Playarr. Opened again, Playarr comes back on that album. With music playing, the TV shouldn't close it at
  all.

## The OLED

- [ ] **Art mode.** Leave Now Playing alone for a minute while it plays. The cover starts drifting slowly, the text
  dims, the rail is covered, and nothing bright stands still. The first key only wakes it.
- [ ] **The TV's own screensaver** takes over from art mode in its own time, and the music plays on.

## The Ambilight (plan 9 §6's spike)

- [ ] **Found.** Settings → Ambilight → "Lights follow the music": the TV shows a PIN, and typing it in pairs. Note in
  plan 9 whether it was found at 127.0.0.1 or at the TV's own address, and whether 1925 answered without pairing.
- [ ] **Following.** While songs play, the lights take each cover's colors within a second of the song starting, and
  fade between songs (more slowly into a DJ transition).
- [ ] **Given back.** Half a minute after the music stops, the Ambilight goes back to the mode and style it had before.
  Turning the switch off gives them back at once.
- [ ] **Lights off.** With the Ambilight turned off on the TV, playing music doesn't turn it on.

## Updates (the sideload flavor)

- [ ] **From GitHub.** With an older release installed, Settings → About offers the newer one, and the rail's Settings
  item has a dot. Install opens the TV's "Install unknown apps" setting the first time, or says where it is when it
  doesn't open; once Playarr is allowed, the update downloads, the TV asks to confirm, and the new version is
  installed. Note whether this Android version asked again for the update after that.

## Firmware

- [ ] **After a firmware update** (only one TP Vision ships of its own accord; don't update the TV for this work, see
  plan 9's risks): Playarr opens signed in, plays, and the Ambilight still pairs. If JointSpace changed, the switch
  says so and the music carries on.
